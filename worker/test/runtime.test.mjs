import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Miniflare, NoOpLog } from "miniflare";
import WebSocket from "ws";
import YProvider from "y-partyserver/provider";
import * as Y from "yjs";

const workerRoot = fileURLToPath(new URL("../", import.meta.url));
const bundlePath = path.join(
  workerRoot,
  ".wrangler-dist/runtime-test/index.js"
);
const site = "0123456789abcdef0123456789abcdef";
const secret =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const origin = "https://wordpress.example.test";
const room = `v1.${site}.1.cG9zdFR5cGUvcG9zdA.MTIz`;
const attachmentFixtureHeader = "X-WP-Collab-Attachment-Fixture";

function createRuntimeOptions(persistPath, limitOverrides = {}) {
  return {
    modules: true,
    modulesRoot: path.dirname(bundlePath),
    scriptPath: bundlePath,
    compatibilityDate: "2025-04-01",
    durableObjects: {
      Collaboration: { className: "Collaboration", useSQLite: true },
    },
    durableObjectsPersist: persistPath,
    bindings: {
      COLLAB_AUTH_KEYS: JSON.stringify({ [site]: secret }),
      COLLAB_MAX_CONNECTIONS_PER_ROOM: "20",
      COLLAB_MAX_MESSAGE_BYTES: "1572864",
      COLLAB_MAX_UPDATE_BYTES: "1500000",
      COLLAB_MAX_DOCUMENT_BYTES: "1500000",
      COLLAB_RATE_WINDOW_SECONDS: "10",
      COLLAB_MAX_MESSAGES_PER_WINDOW: "200",
      COLLAB_MAX_BYTES_PER_WINDOW: "4194304",
      ...limitOverrides,
    },
    log: new NoOpLog(),
  };
}

function createRuntime(persistPath, limitOverrides = {}) {
  return new Miniflare(createRuntimeOptions(persistPath, limitOverrides));
}

function createAttachmentFixtureRuntime(
  persistPath,
  legacyExpiresAtSeconds
) {
  return new Miniflare({
    ...createRuntimeOptions(persistPath),
    scriptPath: path.join(
      path.dirname(bundlePath),
      "attachment-fixture.mjs"
    ),
    modulesRules: [
      { type: "ESModule", include: ["**/*.js"], fallthrough: true },
    ],
    script: `
      import productionWorker, {
        Collaboration as ProductionCollaboration,
      } from "./index.js";

      export class Collaboration extends ProductionCollaboration {
        async onConnect(connection, context) {
          await super.onConnect(connection, context);
          const shape = context.request.headers.get(
            ${JSON.stringify(attachmentFixtureHeader)}
          );
          if (!shape) {
            return;
          }

          const state = { ...(connection.state || {}) };
          delete state.__wpCollabSessionExpires;
          if (shape === "legacy") {
            state.__wpCollabAuthExpires = ${legacyExpiresAtSeconds};
            await this.ctx.storage.setAlarm(
              ${legacyExpiresAtSeconds} * 1000
            );
          } else if (shape === "malformed") {
            state.__wpCollabAuthExpires = "not-seconds";
          } else {
            delete state.__wpCollabAuthExpires;
          }
          connection.setState(state);
        }
      }

      export default productionWorker;
    `,
  });
}

function createLegacyStorageFixtureRuntime(persistPath) {
  return new Miniflare({
    modules: true,
    script: `
      export class Collaboration {
        constructor(ctx) {
          this.ctx = ctx;
        }

        async alarm() {}

        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === "/seed") {
            await this.ctx.storage.put("yjs-state-v1", new Uint8Array([1, 2, 3]));
            await this.ctx.storage.put("lifecycle-marker", "preserved");
            await this.ctx.storage.setAlarm(Date.now() + 60_000);
            return new Response("seeded");
          }
          if (path === "/inspect") {
            return Response.json({
              hasLegacyState: (await this.ctx.storage.get("yjs-state-v1")) !== undefined,
              hasLifecycleAlarm: (await this.ctx.storage.getAlarm()) !== null,
              lifecycleMarker: await this.ctx.storage.get("lifecycle-marker"),
            });
          }
          return new Response("Not found", { status: 404 });
        }
      }

      export default { fetch() { return new Response("ok"); } };
    `,
    compatibilityDate: "2025-04-01",
    durableObjects: {
      Collaboration: { className: "Collaboration", useSQLite: true },
    },
    durableObjectsPersist: persistPath,
    log: new NoOpLog(),
  });
}

function base64UrlEncode(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function mintToken(lifetimeSeconds = 30) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    v: 1,
    aud: "wp-collab-cloudflare",
    site,
    blog: "1",
    origin,
    room,
    sub: "7",
    iat: now,
    nbf: now - 5,
    exp: now + lifetimeSeconds,
  };
  const encoder = new TextEncoder();
  const payload = base64UrlEncode(
    encoder.encode(JSON.stringify(claims))
  );
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload)
  );
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function connect(
  runtime,
  { attachmentShape, lifetimeSeconds = 30 } = {}
) {
  const baseUrl = await runtime.ready;
  const url = new URL(`/parties/collaboration/${room}`, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const token = await mintToken(lifetimeSeconds);
  const options = { origin };
  if (attachmentShape !== undefined) {
    options.headers = { [attachmentFixtureHeader]: attachmentShape };
  }
  const socket = new WebSocket(
    url,
    ["wp-collab-v1", `wp-collab-token.${token}`],
    options
  );
  const close = once(socket, "close");
  await once(socket, "open");
  return { socket, close };
}

function createAuthenticatedWebSocket(issuedTokens) {
  return class AuthenticatedWebSocket extends WebSocket {
    constructor(address, protocols = []) {
      const url = new URL(address);
      const token = url.searchParams.get("token");
      if (!token) {
        throw new Error("WebSocket credential is missing");
      }
      url.searchParams.delete("token");
      issuedTokens.push(token);
      const requestedProtocols = Array.isArray(protocols)
        ? protocols
        : [protocols];
      super(
        url,
        [
          ...requestedProtocols,
          "wp-collab-v1",
          `wp-collab-token.${token}`,
        ],
        { origin }
      );
    }
  };
}

function waitForProviderConnections(provider, expectedCount) {
  return new Promise((resolve, reject) => {
    let connectionCount = 0;
    const timeout = setTimeout(() => {
      provider.off("status", onStatus);
      reject(new Error("timed out waiting for provider reconnect"));
    }, 12_000);
    const onStatus = ({ status }) => {
      if (status !== "connected") {
        return;
      }
      connectionCount += 1;
      if (connectionCount >= expectedCount) {
        clearTimeout(timeout);
        provider.off("status", onStatus);
        resolve();
      }
    };
    provider.on("status", onStatus);
  });
}

function waitForProviderSync(provider) {
  if (provider.synced) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      provider.off("sync", onSync);
      reject(new Error("timed out waiting for provider sync"));
    }, 5_000);
    const onSync = (isSynced) => {
      if (!isSynced) {
        return;
      }
      clearTimeout(timeout);
      provider.off("sync", onSync);
      resolve();
    };
    provider.on("sync", onSync);
  });
}

function encodeVarUint(value) {
  const bytes = [];
  let remaining = value;
  while (remaining > 127) {
    bytes.push((remaining & 127) | 128);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return bytes;
}

function syncMessage(syncType, payload) {
  return Uint8Array.from([
    0,
    syncType,
    ...encodeVarUint(payload.byteLength),
    ...payload,
  ]);
}

function readVarUint(bytes, cursor) {
  let value = 0;
  let multiplier = 1;
  while (cursor.offset < bytes.byteLength) {
    const byte = bytes[cursor.offset++];
    value += (byte & 127) * multiplier;
    if ((byte & 128) === 0) {
      return value;
    }
    multiplier *= 128;
  }
  throw new Error("truncated varuint");
}

function readSyncUpdate(data) {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const cursor = { offset: 0 };
  if (readVarUint(bytes, cursor) !== 0) {
    return null;
  }
  const syncType = readVarUint(bytes, cursor);
  if (syncType !== 1 && syncType !== 2) {
    return null;
  }
  const length = readVarUint(bytes, cursor);
  return bytes.slice(cursor.offset, cursor.offset + length);
}

function waitForSyncUpdate(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for Yjs state")),
      3_000
    );
    const onMessage = (data) => {
      try {
        const update = readSyncUpdate(data);
        if (!update) {
          return;
        }
        clearTimeout(timeout);
        socket.off("message", onMessage);
        resolve(update);
      } catch (error) {
        clearTimeout(timeout);
        socket.off("message", onMessage);
        reject(error);
      }
    };
    socket.on("message", onMessage);
  });
}

async function closeSocket(socket, close) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.close(1000, "test complete");
  }
  await close;
}

test("workerd enforces room capacity", async (t) => {
  const persistPath = await mkdtemp(path.join(tmpdir(), "wp-collab-runtime-"));
  const runtime = createRuntime(persistPath, {
    COLLAB_MAX_CONNECTIONS_PER_ROOM: "1",
  });
  t.after(async () => {
    await runtime.dispose();
    await rm(persistPath, { recursive: true, force: true });
  });

  const first = await connect(runtime);
  const second = await connect(runtime);
  const [resourceCode] = await second.close;
  assert.equal(resourceCode, 4008);
  await closeSocket(first.socket, first.close);

});

test("workerd keeps a session alive past grant expiry and closes at the session timeout", async (t) => {
  const persistPath = await mkdtemp(path.join(tmpdir(), "wp-collab-session-"));
  const runtime = createRuntime(persistPath, {
    COLLAB_CONNECTION_TIMEOUT_SECONDS: "4",
  });
  t.after(async () => {
    await runtime.dispose();
    await rm(persistPath, { recursive: true, force: true });
  });

  const established = await connect(runtime, { lifetimeSeconds: 2 });
  const establishedOpenedAt = Date.now();
  await delay(2_500);
  assert.equal(
    established.socket.readyState,
    WebSocket.OPEN,
    "an expired connection grant must not remove the established session"
  );

  const peer = await connect(runtime);
  const peerOpenedAt = Date.now();
  const updatePromise = waitForSyncUpdate(peer.socket);
  const source = new Y.Doc();
  source.getText("content").insert(0, "relayed after grant expiry");
  established.socket.send(syncMessage(2, Y.encodeStateAsUpdate(source)));
  const peerState = new Y.Doc();
  Y.applyUpdate(peerState, await updatePromise);
  assert.equal(peerState.getText("content").toString(), "relayed after grant expiry");

  const [sessionCode] = await established.close;
  const establishedClosedAt = Date.now();
  assert.equal(sessionCode, 4001);

  assert.equal(
    peer.socket.readyState,
    WebSocket.OPEN,
    "the later session must survive the earlier session's alarm"
  );
  peerState.getText("content").insert(
    peerState.getText("content").length,
    " and after the earlier session timeout"
  );
  peer.socket.send(syncMessage(2, Y.encodeStateAsUpdate(peerState)));
  const observer = await connect(runtime);
  const observerUpdate = waitForSyncUpdate(observer.socket);
  const observerState = new Y.Doc();
  observer.socket.send(syncMessage(0, Y.encodeStateVector(observerState)));
  Y.applyUpdate(observerState, await observerUpdate);
  assert.equal(
    observerState.getText("content").toString(),
    "relayed after grant expiry and after the earlier session timeout"
  );

  const [peerSessionCode] = await peer.close;
  const peerClosedAt = Date.now();
  assert.equal(peerSessionCode, 4001);
  assert.ok(
    peerClosedAt >= peerOpenedAt + 3_500,
    "the later session must close at its own four-second deadline"
  );
  assert.ok(
    peerClosedAt >= establishedClosedAt + 1_500,
    "session alarms must preserve the ordering of independently established deadlines"
  );
  assert.ok(
    establishedClosedAt >= establishedOpenedAt + 3_500,
    "the earlier session must close at its session deadline, not its grant deadline"
  );
  source.destroy();
  peerState.destroy();
  observerState.destroy();
  await closeSocket(observer.socket, observer.close);
});

test("y-partyserver reconnects after a real session timeout with a fresh grant", async (t) => {
  const persistPath = await mkdtemp(path.join(tmpdir(), "wp-collab-provider-"));
  const runtime = createRuntime(persistPath, {
    COLLAB_CONNECTION_TIMEOUT_SECONDS: "3",
  });
  const issuedTokens = [];
  let credentialIssueCount = 0;
  const statuses = [];
  const providerDocument = new Y.Doc();
  providerDocument.getText("content").insert(0, "survived timeout");
  const baseUrl = await runtime.ready;
  const provider = new YProvider(baseUrl.host, room, providerDocument, {
    connect: false,
    disableBc: true,
    maxBackoffTime: 100,
    params: async () => {
      credentialIssueCount += 1;
      return { token: await mintToken(1) };
    },
    party: "collaboration",
    protocol: baseUrl.protocol === "https:" ? "wss" : "ws",
    WebSocketPolyfill: createAuthenticatedWebSocket(issuedTokens),
  });
  const recordStatus = ({ status }) => statuses.push(status);
  provider.on("status", recordStatus);
  t.after(async () => {
    provider.off("status", recordStatus);
    provider.destroy();
    providerDocument.destroy();
    await runtime.dispose();
    await rm(persistPath, { recursive: true, force: true });
  });

  const reconnected = waitForProviderConnections(provider, 2);
  await provider.connect();
  await reconnected;
  await waitForProviderSync(provider);
  await delay(1_500);

  assert.equal(
    credentialIssueCount,
    2,
    "one initial grant and exactly one refreshed grant must be issued"
  );
  assert.equal(
    issuedTokens.length,
    2,
    "the provider must create exactly one replacement WebSocket"
  );
  assert.equal(
    statuses.filter((status) => status === "connected").length,
    2,
    "the provider must stabilize after exactly one reconnect"
  );
  assert.notEqual(
    issuedTokens[0],
    issuedTokens[1],
    "the reconnect must obtain a fresh credential"
  );
  assert.equal(provider.wsconnected, true);

  providerDocument
    .getText("content")
    .insert(providerDocument.getText("content").length, " and converged");
  const peer = await connect(runtime);
  const updatePromise = waitForSyncUpdate(peer.socket);
  const peerDocument = new Y.Doc();
  peer.socket.send(syncMessage(0, Y.encodeStateVector(peerDocument)));
  Y.applyUpdate(peerDocument, await updatePromise);
  assert.equal(
    peerDocument.getText("content").toString(),
    "survived timeout and converged"
  );
  peerDocument.destroy();
  await closeSocket(peer.socket, peer.close);
});

test("workerd honors legacy hibernation expiry and fails closed for invalid attachment state", async (t) => {
  const persistPath = await mkdtemp(
    path.join(tmpdir(), "wp-collab-legacy-attachment-")
  );
  const legacyExpiresAtSeconds = Math.floor(Date.now() / 1_000) + 4;
  const runtime = createAttachmentFixtureRuntime(
    persistPath,
    legacyExpiresAtSeconds
  );
  t.after(async () => {
    await runtime.dispose();
    await rm(persistPath, { recursive: true, force: true });
  });

  const legacy = await connect(runtime, { attachmentShape: "legacy" });
  const malformed = await connect(runtime, { attachmentShape: "malformed" });
  const missing = await connect(runtime, { attachmentShape: "missing" });

  malformed.socket.send(new Uint8Array([0]));
  missing.socket.send(new Uint8Array([0]));
  const [[malformedCode], [missingCode]] = await Promise.all([
    malformed.close,
    missing.close,
  ]);
  assert.equal(malformedCode, 4001);
  assert.equal(missingCode, 4001);

  const millisecondsBeforeDeadline =
    legacyExpiresAtSeconds * 1_000 - Date.now();
  if (millisecondsBeforeDeadline > 500) {
    await delay(millisecondsBeforeDeadline - 500);
  }
  assert.equal(
    legacy.socket.readyState,
    WebSocket.OPEN,
    "a legacy seconds attachment must remain open before its converted deadline"
  );

  const [legacyCode] = await legacy.close;
  assert.equal(legacyCode, 4001);
  assert.ok(
    Date.now() >= legacyExpiresAtSeconds * 1_000,
    "a legacy seconds attachment must close at or after its converted deadline"
  );
});

test("workerd does not retain Yjs state after a runtime restart", async (t) => {
  const persistPath = await mkdtemp(path.join(tmpdir(), "wp-collab-persist-"));
  let runtime = createRuntime(persistPath);
  t.after(async () => {
    await runtime.dispose();
    await rm(persistPath, { recursive: true, force: true });
  });

  const writer = await connect(runtime);
  const source = new Y.Doc();
  source.getText("content").insert(0, "discarded after Worker restart");
  writer.socket.send(syncMessage(2, Y.encodeStateAsUpdate(source)));
  const seedConfirmation = waitForSyncUpdate(writer.socket);
  const seedQuery = new Y.Doc();
  writer.socket.send(syncMessage(0, Y.encodeStateVector(seedQuery)));
  const seededUpdate = await seedConfirmation;
  const seededRelay = new Y.Doc();
  Y.applyUpdate(seededRelay, seededUpdate);
  assert.equal(
    seededRelay.getText("content").toString(),
    "discarded after Worker restart"
  );
  source.destroy();
  seedQuery.destroy();
  seededRelay.destroy();
  await closeSocket(writer.socket, writer.close);
  await runtime.dispose();

  runtime = createRuntime(persistPath);
  const reader = await connect(runtime);
  const updatePromise = waitForSyncUpdate(reader.socket);
  const emptyDocument = new Y.Doc();
  reader.socket.send(
    syncMessage(0, Y.encodeStateVector(emptyDocument))
  );
  const update = await updatePromise;
  const restored = new Y.Doc();
  Y.applyUpdate(restored, update);
  assert.equal(restored.getText("content").toString(), "");
  emptyDocument.destroy();
  restored.destroy();
  await closeSocket(reader.socket, reader.close);
});

test("workerd accepts a WordPress-sized snapshot into an empty relay", async (t) => {
  const persistPath = await mkdtemp(path.join(tmpdir(), "wp-collab-hydrate-"));
  const runtime = createRuntime(persistPath);
  t.after(async () => {
    await runtime.dispose();
    await rm(persistPath, { recursive: true, force: true });
  });

  const writer = await connect(runtime);
  const source = new Y.Doc();
  source.getText("content").insert(0, "x".repeat(600_000));
  const snapshot = Y.encodeStateAsUpdate(source);
  assert.ok(snapshot.byteLength > 524_288);
  assert.ok(snapshot.byteLength <= 1_500_000);
  writer.socket.send(syncMessage(2, snapshot));

  const reader = await connect(runtime);
  const updatePromise = waitForSyncUpdate(reader.socket);
  const readerState = new Y.Doc();
  reader.socket.send(syncMessage(0, Y.encodeStateVector(readerState)));
  Y.applyUpdate(readerState, await updatePromise);
  assert.equal(readerState.getText("content").length, 600_000);

  source.destroy();
  readerState.destroy();
  await closeSocket(reader.socket, reader.close);
  await closeSocket(writer.socket, writer.close);
});

test("workerd scrubs legacy Yjs storage when a room activates", async (t) => {
  const persistPath = await mkdtemp(path.join(tmpdir(), "wp-collab-legacy-"));
  let runtime = createLegacyStorageFixtureRuntime(persistPath);
  t.after(async () => {
    await runtime.dispose();
    await rm(persistPath, { recursive: true, force: true });
  });

  let namespace = await runtime.getDurableObjectNamespace("Collaboration");
  let response = await namespace
    .get(namespace.idFromName(room))
    .fetch("http://durable-object/seed");
  assert.equal(response.status, 200);
  await runtime.dispose();

  runtime = createRuntime(persistPath);
  const reader = await connect(runtime);
  await closeSocket(reader.socket, reader.close);
  await runtime.dispose();

  runtime = createLegacyStorageFixtureRuntime(persistPath);
  namespace = await runtime.getDurableObjectNamespace("Collaboration");
  response = await namespace
    .get(namespace.idFromName(room))
    .fetch("http://durable-object/inspect");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    hasLegacyState: false,
    hasLifecycleAlarm: true,
    lifecycleMarker: "preserved",
  });
});
