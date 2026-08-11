import { YServer } from "y-partyserver";
import { routePartykitRequest } from "partyserver";
import type { Connection, ConnectionContext } from "partyserver";
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

const YJS_STATE_KEY = "yjs-state-v1";
const AUTH_EXPIRY_STATE_KEY = "__wpCollabAuthExpires";
const AUTH_EXPIRED_CLOSE_CODE = 4001;
type CollaborationConnectionState = Record<string, unknown> & {
  [AUTH_EXPIRY_STATE_KEY]?: number;
};

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

  async onLoad(): Promise<void> {
    const state = await this.ctx.storage.get<ArrayBuffer>(YJS_STATE_KEY);
    if (state) {
      Y.applyUpdate(this.document, new Uint8Array(state));
    }
  }

  async onSave(): Promise<void> {
    const update = Y.encodeStateAsUpdate(this.document);
    const state = update.buffer.slice(
      update.byteOffset,
      update.byteOffset + update.byteLength
    );
    await this.ctx.storage.put(YJS_STATE_KEY, state);
  }

  async onConnect(
    connection: Connection<CollaborationConnectionState>,
    context: ConnectionContext
  ): Promise<void> {
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
    super.onConnect(connection, context);
  }

  async onClose(
    connection: Connection<CollaborationConnectionState>,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    super.onClose(connection, code, reason, wasClean);
    await this.scheduleNextAuthAlarm();
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

interface Env {
  Collaboration: DurableObjectNamespace<Collaboration>;
  COLLAB_AUTH_KEYS: string;
}

let cachedAuthKeysSource: string | undefined;
let cachedAuthKeys: Record<string, Promise<CryptoKey>> | undefined;

function getAuthKeys(env: Env): Record<string, Promise<CryptoKey>> {
  if (!cachedAuthKeys || cachedAuthKeysSource !== env.COLLAB_AUTH_KEYS) {
    cachedAuthKeys = Object.create(null) as Record<string, Promise<CryptoKey>>;
    for (const [site, secret] of Object.entries(
      parseAuthKeys(env.COLLAB_AUTH_KEYS)
    )) {
      cachedAuthKeys[site] = crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"]
      );
    }
    cachedAuthKeysSource = env.COLLAB_AUTH_KEYS;
  }
  return cachedAuthKeys;
}

function authFailure(error: unknown): Response {
  const status = error instanceof AuthError ? error.status : 503;
  const code = error instanceof AuthError ? error.code : "auth_unavailable";
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({ status: "ok", service: "wp-collab-cloudflare" }),
        { headers: { "Content-Type": "application/json" } }
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
