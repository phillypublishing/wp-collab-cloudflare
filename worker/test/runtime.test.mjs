import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Miniflare, NoOpLog } from "miniflare";
import WebSocket from "ws";
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

function createRuntime(persistPath, limitOverrides = {}) {
  return new Miniflare({
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

async function connect(runtime, lifetimeSeconds = 30) {
  const baseUrl = await runtime.ready;
  const url = new URL(`/parties/collaboration/${room}`, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const token = await mintToken(lifetimeSeconds);
  const socket = new WebSocket(
    url,
    ["wp-collab-v1", `wp-collab-token.${token}`],
    { origin }
  );
  const close = once(socket, "close");
  await once(socket, "open");
  return { socket, close };
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

test("workerd enforces room capacity and authentication-expiry alarms", async (t) => {
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

  const expiring = await connect(runtime, 1);
  const [expiryCode] = await expiring.close;
  assert.equal(expiryCode, 4001);

  const refreshed = await connect(runtime);
  assert.equal(refreshed.socket.readyState, WebSocket.OPEN);
  await closeSocket(refreshed.socket, refreshed.close);
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
