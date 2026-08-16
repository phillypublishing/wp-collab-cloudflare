import { YServer } from "y-partyserver";
import { routePartykitRequest } from "partyserver";
import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import * as Y from "yjs";

import {
  AuthError,
  getAuthExpiryDelay,
  parseAuthKeys,
  routeAfterWebSocketGuard,
  SAFE_PROTOCOL,
  sanitizeAuthenticatedRequest,
  verifyConnectionRequest,
} from "./auth.js";
import { clearLegacyDocumentState } from "./ephemeral-relay.js";
import {
  consumeMessageBudget,
  getYjsUpdate,
  hasConnectionCapacity,
  messageByteLength,
  parseResourceLimits,
  ResourceLimitError,
  trySetConnectionState,
} from "./limits.js";
import {
  recordConfigurationInvalid,
  recordConnectionAccepted,
  recordConnectionRejected,
  recordResourceLimit,
} from "./observability.js";

const SESSION_EXPIRY_STATE_KEY = "__wpCollabSessionExpires";
const LEGACY_AUTH_EXPIRY_STATE_KEY = "__wpCollabAuthExpires";
const RATE_STATE_KEY = "__wpCollabRateWindow";
const SESSION_EXPIRED_CLOSE_CODE = 4001;
const RESOURCE_LIMIT_CLOSE_CODE = 4008;
type RateState = {
  windowStartedAt: number;
  messagesInWindow: number;
  bytesInWindow: number;
};
type CollaborationConnectionState = Record<string, unknown> & {
  [SESSION_EXPIRY_STATE_KEY]?: number;
  [LEGACY_AUTH_EXPIRY_STATE_KEY]?: number;
  [RATE_STATE_KEY]?: RateState;
};
type ResourceLimits = ReturnType<typeof parseResourceLimits>;

interface Env {
  Collaboration: DurableObjectNamespace<Collaboration>;
  COLLAB_AUTH_KEYS: string;
  COLLAB_METRICS?: AnalyticsEngineDataset;
  COLLAB_MAX_CONNECTIONS_PER_ROOM?: string;
  COLLAB_CONNECTION_TIMEOUT_SECONDS?: string;
  COLLAB_MAX_MESSAGE_BYTES?: string;
  COLLAB_MAX_UPDATE_BYTES?: string;
  COLLAB_MAX_DOCUMENT_BYTES?: string;
  COLLAB_RATE_WINDOW_SECONDS?: string;
  COLLAB_MAX_MESSAGES_PER_WINDOW?: string;
  COLLAB_MAX_BYTES_PER_WINDOW?: string;
}

/**
 * Durable Object that runs a Yjs sync relay for one "room" (one post being edited).
 * Uses WebSocket Hibernation so idle editing sessions cost nothing.
 * y-partyserver handles:
 *   - Yjs sync protocol (SyncStep1/SyncStep2)
 *   - Awareness relay (cursor positions, user presence)
 * Document bytes remain in memory only. Gutenberg persists the canonical Yjs
 * snapshot in WordPress; y-partyserver re-syncs from connected clients after
 * hibernation and resets the in-memory document after the final peer leaves.
 */
export class Collaboration extends YServer {
  static options = {
    hibernate: true,
  };

  private readonly resourceLimits: ResourceLimits;
  private readonly metrics?: AnalyticsEngineDataset;
  private documentBudgetBytes: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.resourceLimits = parseResourceLimits(env);
    this.metrics = env.COLLAB_METRICS;
    this.documentBudgetBytes = Y.encodeStateAsUpdate(this.document).byteLength;
  }

  private rejectForResourceLimit(
    connection: Connection,
    event: string,
    observed?: number,
    limit?: number
  ): void {
    logSecurityEvent(event, {
      ...(observed === undefined ? {} : { observed }),
      ...(limit === undefined ? {} : { limit }),
    });
    recordResourceLimit(this.metrics, event, observed, limit);
    connection.close(RESOURCE_LIMIT_CLOSE_CODE, "Room resource limit exceeded");
  }

  async onLoad(): Promise<void> {
    // Versions before the ephemeral-relay model stored document bytes here.
    // Delete that exact legacy value without touching alarms or hibernating
    // WebSocket attachments, which remain part of the connection lifecycle.
    await clearLegacyDocumentState(this.ctx.storage);
  }

  async onConnect(
    connection: Connection<CollaborationConnectionState>,
    context: ConnectionContext
  ): Promise<void> {
    let connectionCount = 0;
    for (const _connection of this.getConnections()) {
      connectionCount += 1;
      if (!hasConnectionCapacity(connectionCount, this.resourceLimits)) {
        this.rejectForResourceLimit(
          connection,
          "connection_limit_exceeded",
          connectionCount,
          this.resourceLimits.maxConnectionsPerRoom
        );
        return;
      }
    }

    const grantDelay = getAuthExpiryDelay(context.request);
    if (grantDelay === 0) {
      connection.close(SESSION_EXPIRED_CLOSE_CODE, "Authentication expired");
      return;
    }

    const sessionExpiresAt =
      Date.now() + this.resourceLimits.connectionTimeoutMilliseconds;
    if (
      !trySetConnectionState(connection, (state) => ({
        ...(state || {}),
        [SESSION_EXPIRY_STATE_KEY]: sessionExpiresAt,
      }))
    ) {
      this.rejectForResourceLimit(
        connection,
        "connection_state_limit_exceeded"
      );
      return;
    }

    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null || sessionExpiresAt < currentAlarm) {
      await this.ctx.storage.setAlarm(sessionExpiresAt);
    }
    await super.onConnect(connection, context);
  }

  async onMessage(
    connection: Connection<CollaborationConnectionState>,
    message: WSMessage
  ): Promise<void> {
    const expiresAt = getConnectionExpiryMilliseconds(connection.state);
    if (expiresAt === undefined || expiresAt <= Date.now()) {
      connection.close(
        SESSION_EXPIRED_CLOSE_CODE,
        "Connection timed out. Reconnect."
      );
      return;
    }

    const byteLength = messageByteLength(message);
    if (byteLength > this.resourceLimits.maxMessageBytes) {
      this.rejectForResourceLimit(
        connection,
        "message_limit_exceeded",
        byteLength,
        this.resourceLimits.maxMessageBytes
      );
      return;
    }

    let update: Uint8Array | null;
    try {
      update = getYjsUpdate(message);
    } catch (error) {
      if (error instanceof ResourceLimitError) {
        this.rejectForResourceLimit(connection, error.code);
        return;
      }
      throw error;
    }

    if (update && update.byteLength > this.resourceLimits.maxUpdateBytes) {
      this.rejectForResourceLimit(
        connection,
        "update_limit_exceeded",
        update.byteLength,
        this.resourceLimits.maxUpdateBytes
      );
      return;
    }

    const budget = consumeMessageBudget(
      connection.state?.[RATE_STATE_KEY],
      this.resourceLimits,
      byteLength
    );
    if (
      !trySetConnectionState(connection, (state) => ({
        ...(state || {}),
        [RATE_STATE_KEY]: budget.state,
      }))
    ) {
      this.rejectForResourceLimit(
        connection,
        "connection_state_limit_exceeded"
      );
      return;
    }
    if (!budget.allowed) {
      this.rejectForResourceLimit(
        connection,
        budget.reason || "rate_limit_exceeded"
      );
      return;
    }

    if (update) {
      const projectedBudget = this.documentBudgetBytes + update.byteLength;
      const compactionThreshold =
        this.resourceLimits.maxDocumentBytes -
        this.resourceLimits.maxUpdateBytes;
      if (projectedBudget > compactionThreshold) {
        try {
          const current = Y.encodeStateAsUpdate(this.document);
          const merged = Y.mergeUpdates([current, update]);
          if (merged.byteLength > this.resourceLimits.maxDocumentBytes) {
            this.rejectForResourceLimit(
              connection,
              "document_limit_exceeded",
              merged.byteLength,
              this.resourceLimits.maxDocumentBytes
            );
            return;
          }
          this.documentBudgetBytes = merged.byteLength;
        } catch {
          this.rejectForResourceLimit(
            connection,
            "malformed_yjs_update"
          );
          return;
        }
      } else {
        // The sum of accepted update sizes is a conservative budget. Avoid an
        // O(document-size) merge on ordinary keystrokes; compact exactly only
        // when one maximum-size update could reach the room ceiling.
        this.documentBudgetBytes = projectedBudget;
      }
    }

    await super.onMessage(connection, message);
  }

  async onClose(
    connection: Connection<CollaborationConnectionState>,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    await super.onClose(connection, code, reason, wasClean);
    for (const _connection of this.getConnections()) {
      return;
    }
    await this.resetDocument();
    this.documentBudgetBytes = Y.encodeStateAsUpdate(this.document).byteLength;
    // Keep the existing earliest alarm. If its connection closed early, the
    // harmless extra wakeup will compact the schedule in one O(N) scan. This
    // avoids rescanning every remaining socket during mass disconnects.
  }

  async onAlarm(): Promise<void> {
    const now = Date.now();
    let nextExpiry: number | undefined;
    for (const connection of this.getConnections<CollaborationConnectionState>()) {
      const expiresAt = getConnectionExpiryMilliseconds(connection.state);
      if (expiresAt === undefined || expiresAt <= now) {
        connection.close(
          SESSION_EXPIRED_CLOSE_CODE,
          "Connection timed out. Reconnect."
        );
      } else if (nextExpiry === undefined || expiresAt < nextExpiry) {
        nextExpiry = expiresAt;
      }
    }

    if (nextExpiry === undefined) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, nextExpiry));
    }
  }

}

function getConnectionExpiryMilliseconds(
  state: CollaborationConnectionState | null | undefined
): number | undefined {
  const sessionExpiry = state?.[SESSION_EXPIRY_STATE_KEY];
  if (Number.isSafeInteger(sessionExpiry)) {
    return sessionExpiry;
  }

  // Connections accepted by pre-session-timeout releases retain their
  // hibernation attachment during deployment. Let their existing credential
  // expiry trigger one final reconnect rather than silently extending them.
  const legacyAuthExpiry = state?.[LEGACY_AUTH_EXPIRY_STATE_KEY];
  return Number.isSafeInteger(legacyAuthExpiry)
    ? (legacyAuthExpiry as number) * 1_000
    : undefined;
}

let cachedAuthKeysSource: string | undefined;
type ImportedSiteKeys =
  | Promise<CryptoKey>
  | {
      legacy?: Promise<CryptoKey>;
      keys: Record<string, Promise<CryptoKey>>;
    };
let cachedAuthKeys: Record<string, ImportedSiteKeys> | undefined;

function importAuthKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

function getAuthKeys(env: Env): Record<string, ImportedSiteKeys> {
  if (!cachedAuthKeys || cachedAuthKeysSource !== env.COLLAB_AUTH_KEYS) {
    cachedAuthKeys = Object.create(null) as Record<string, ImportedSiteKeys>;
    for (const [site, configuredKeys] of Object.entries(
      parseAuthKeys(env.COLLAB_AUTH_KEYS)
    )) {
      if (typeof configuredKeys === "string") {
        cachedAuthKeys[site] = importAuthKey(configuredKeys);
        continue;
      }
      const importedKeys = Object.create(null) as Record<
        string,
        Promise<CryptoKey>
      >;
      for (const [keyId, secret] of Object.entries(configuredKeys.keys)) {
        importedKeys[keyId] = importAuthKey(secret);
      }
      cachedAuthKeys[site] = {
        ...(configuredKeys.legacy === undefined
          ? {}
          : { legacy: importAuthKey(configuredKeys.legacy) }),
        keys: importedKeys,
      };
    }
    cachedAuthKeysSource = env.COLLAB_AUTH_KEYS;
  }
  return cachedAuthKeys;
}

function authFailure(
  error: unknown,
  metrics?: AnalyticsEngineDataset
): Response {
  const status = error instanceof AuthError ? error.status : 503;
  const code = error instanceof AuthError ? error.code : "auth_unavailable";
  logSecurityEvent("connection_rejected", { code, status });
  recordConnectionRejected(metrics, code);
  return Response.json(
    { error: code },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}

function logSecurityEvent(
  event: string,
  fields: Record<string, string | number> = {}
): void {
  // Never add request URLs, headers, room names, user IDs, or message content
  // here: this stream is intentionally safe for production log export.
  console.warn(JSON.stringify({ service: "wp-collab-cloudflare", event, ...fields }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      parseResourceLimits(env);
      getAuthKeys(env);
    } catch {
      logSecurityEvent("configuration_invalid");
      recordConfigurationInvalid(env.COLLAB_METRICS);
      return Response.json(
        { status: "unavailable", service: "wp-collab-cloudflare" },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Health check
    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({ status: "ok", service: "wp-collab-cloudflare" }),
        {
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/json",
          },
        }
      );
    }

    // Use PartyServer's built-in routing: /parties/<bindingName>/<roomId>.
    // Authentication runs before PartyServer forwards the WebSocket upgrade to
    // the Durable Object, so rejected requests never allocate or join a room.
    const response = await routeAfterWebSocketGuard(request, () =>
      routePartykitRequest(request, env, {
        onBeforeConnect: async (connectionRequest, lobby) => {
          try {
            const claims = await verifyConnectionRequest({
              request: connectionRequest,
              room: lobby.name,
              authKeys: getAuthKeys(env),
            });
            return sanitizeAuthenticatedRequest(
              connectionRequest,
              Number(claims.exp)
            );
          } catch (error) {
            return authFailure(error, env.COLLAB_METRICS);
          }
        },
      })
    );
    if (response) {
      if (response.status === 101 && response.webSocket) {
        recordConnectionAccepted(env.COLLAB_METRICS);
        const headers = new Headers(response.headers);
        headers.set("Sec-WebSocket-Protocol", SAFE_PROTOCOL);
        return new Response(null, {
          status: 101,
          headers,
          webSocket: response.webSocket,
        });
      }
      return response;
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
