import { YServer } from "y-partyserver";
import { routePartykitRequest } from "partyserver";
import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import * as Y from "yjs";

import {
  AUTH_EXPIRY_HEADER,
  AuthError,
  getAuthExpiryDelay,
  parseAuthKeys,
  routeAfterWebSocketGuard,
  SAFE_PROTOCOL,
  sanitizeAuthenticatedRequest,
  verifyConnectionRequest,
} from "./auth.js";
import {
  consumeMessageBudget,
  getYjsUpdate,
  hasConnectionCapacity,
  messageByteLength,
  parseResourceLimits,
  ResourceLimitError,
} from "./limits.js";

const YJS_STATE_KEY = "yjs-state-v1";
const AUTH_EXPIRY_STATE_KEY = "__wpCollabAuthExpires";
const RATE_STATE_KEY = "__wpCollabRateWindow";
const AUTH_EXPIRED_CLOSE_CODE = 4001;
const RESOURCE_LIMIT_CLOSE_CODE = 4008;
type RateState = {
  windowStartedAt: number;
  messagesInWindow: number;
  bytesInWindow: number;
};
type CollaborationConnectionState = Record<string, unknown> & {
  [AUTH_EXPIRY_STATE_KEY]?: number;
  [RATE_STATE_KEY]?: RateState;
};
type ResourceLimits = ReturnType<typeof parseResourceLimits>;

interface Env {
  Collaboration: DurableObjectNamespace<Collaboration>;
  COLLAB_AUTH_KEYS: string;
  COLLAB_MAX_CONNECTIONS_PER_ROOM?: string;
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
 * This subclass persists a compact Yjs update to Durable Object storage.
 */
export class Collaboration extends YServer {
  static options = {
    hibernate: true,
  };

  static callbackOptions = {
    debounceWait: 250,
    debounceMaxWait: 1000,
  };

  private readonly resourceLimits: ResourceLimits;
  private documentBudgetBytes = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.resourceLimits = parseResourceLimits(env);
  }

  async onLoad(): Promise<void> {
    const state = await this.ctx.storage.get<ArrayBuffer>(YJS_STATE_KEY);
    if (state) {
      if (state.byteLength > this.resourceLimits.maxDocumentBytes) {
        logSecurityEvent("stored_document_limit_exceeded", {
          observed: state.byteLength,
          limit: this.resourceLimits.maxDocumentBytes,
        });
        throw new Error("Stored collaboration state exceeds the configured limit");
      }
      Y.applyUpdate(this.document, new Uint8Array(state));
    }
    this.documentBudgetBytes = Y.encodeStateAsUpdate(this.document).byteLength;
  }

  async onSave(): Promise<void> {
    const update = Y.encodeStateAsUpdate(this.document);
    if (update.byteLength > this.resourceLimits.maxDocumentBytes) {
      logSecurityEvent("document_limit_exceeded_during_save", {
        observed: update.byteLength,
        limit: this.resourceLimits.maxDocumentBytes,
      });
      throw new Error("Collaboration state exceeds the configured limit");
    }
    const state = update.buffer.slice(
      update.byteOffset,
      update.byteOffset + update.byteLength
    );
    this.documentBudgetBytes = update.byteLength;
    await this.ctx.storage.put(YJS_STATE_KEY, state);
  }

  async onConnect(
    connection: Connection<CollaborationConnectionState>,
    context: ConnectionContext
  ): Promise<void> {
    let connectionCount = 0;
    for (const _connection of this.getConnections()) {
      connectionCount += 1;
      if (!hasConnectionCapacity(connectionCount, this.resourceLimits)) {
        rejectForResourceLimit(
          connection,
          "connection_limit_exceeded",
          connectionCount,
          this.resourceLimits.maxConnectionsPerRoom
        );
        return;
      }
    }

    const delay = getAuthExpiryDelay(context.request);
    const expiresAt = Number(context.request.headers.get(AUTH_EXPIRY_HEADER));
    connection.setState((state) => ({
      ...(state || {}),
      [AUTH_EXPIRY_STATE_KEY]: expiresAt,
    }));

    if (delay === 0) {
      connection.close(AUTH_EXPIRED_CLOSE_CODE, "Authentication expired");
      return;
    }

    const currentAlarm = await this.ctx.storage.getAlarm();
    const expiresAtMilliseconds = expiresAt * 1000;
    if (currentAlarm === null || expiresAtMilliseconds < currentAlarm) {
      await this.ctx.storage.setAlarm(expiresAtMilliseconds);
    }
    await super.onConnect(connection, context);
  }

  async onMessage(
    connection: Connection<CollaborationConnectionState>,
    message: WSMessage
  ): Promise<void> {
    const expiresAt = connection.state?.[AUTH_EXPIRY_STATE_KEY];
    if (!Number.isSafeInteger(expiresAt) || (expiresAt as number) * 1000 <= Date.now()) {
      connection.close(AUTH_EXPIRED_CLOSE_CODE, "Authentication expired");
      return;
    }

    const byteLength = messageByteLength(message);
    if (byteLength > this.resourceLimits.maxMessageBytes) {
      rejectForResourceLimit(
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
        rejectForResourceLimit(connection, error.code);
        return;
      }
      throw error;
    }

    if (update && update.byteLength > this.resourceLimits.maxUpdateBytes) {
      rejectForResourceLimit(
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
    connection.setState((state) => ({
      ...(state || {}),
      [RATE_STATE_KEY]: budget.state,
    }));
    if (!budget.allowed) {
      rejectForResourceLimit(
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
            rejectForResourceLimit(
              connection,
              "document_limit_exceeded",
              merged.byteLength,
              this.resourceLimits.maxDocumentBytes
            );
            return;
          }
          this.documentBudgetBytes = merged.byteLength;
        } catch {
          rejectForResourceLimit(connection, "malformed_yjs_update");
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
    // Keep the existing earliest alarm. If its connection closed early, the
    // harmless extra wakeup will compact the schedule in one O(N) scan. This
    // avoids rescanning every remaining socket during mass disconnects.
  }

  async onAlarm(): Promise<void> {
    const now = Date.now();
    for (const connection of this.getConnections<CollaborationConnectionState>()) {
      const expiresAt = connection.state?.[AUTH_EXPIRY_STATE_KEY];
      if (
        !Number.isSafeInteger(expiresAt) ||
        (expiresAt as number) * 1000 <= now
      ) {
        connection.close(AUTH_EXPIRED_CLOSE_CODE, "Authentication expired");
      }
    }
    await this.scheduleNextAuthAlarm();
  }

  private async scheduleNextAuthAlarm(): Promise<void> {
    let nextExpiry: number | undefined;
    const nowSeconds = Date.now() / 1000;
    for (const connection of this.getConnections<CollaborationConnectionState>()) {
      const expiresAt = connection.state?.[AUTH_EXPIRY_STATE_KEY];
      if (
        Number.isSafeInteger(expiresAt) &&
        (expiresAt as number) > nowSeconds &&
        (nextExpiry === undefined || (expiresAt as number) < nextExpiry)
      ) {
        nextExpiry = expiresAt as number;
      }
    }

    if (nextExpiry === undefined) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, nextExpiry * 1000));
    }
  }
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

function authFailure(error: unknown): Response {
  const status = error instanceof AuthError ? error.status : 503;
  const code = error instanceof AuthError ? error.code : "auth_unavailable";
  logSecurityEvent("connection_rejected", { code, status });
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

function rejectForResourceLimit(
  connection: Connection,
  event: string,
  observed?: number,
  limit?: number
): void {
  logSecurityEvent(event, {
    ...(observed === undefined ? {} : { observed }),
    ...(limit === undefined ? {} : { limit }),
  });
  connection.close(RESOURCE_LIMIT_CLOSE_CODE, "Room resource limit exceeded");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      parseResourceLimits(env);
      getAuthKeys(env);
    } catch {
      logSecurityEvent("configuration_invalid");
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
            return authFailure(error);
          }
        },
      })
    );
    if (response) {
      if (response.status === 101 && response.webSocket) {
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
