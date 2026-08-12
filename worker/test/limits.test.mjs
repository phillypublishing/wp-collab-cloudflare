import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeMessageBudget,
  getYjsUpdate,
  hasConnectionCapacity,
  messageByteLength,
  parseResourceLimits,
  restoreStoredDocumentState,
  ResourceLimitError,
  trySetConnectionState,
} from "../src/limits.js";
import * as Y from "yjs";

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

test("parseResourceLimits supplies bounded production defaults", () => {
  const limits = parseResourceLimits({});

  assert.equal(limits.maxConnectionsPerRoom, 20);
  assert.equal(limits.maxMessageBytes, 1_048_576);
  assert.equal(limits.maxUpdateBytes, 524_288);
  assert.equal(limits.maxDocumentBytes, 1_500_000);
  assert.equal(limits.rateWindowMilliseconds, 10_000);
  assert.equal(limits.maxMessagesPerWindow, 200);
  assert.equal(limits.maxBytesPerWindow, 4_194_304);
});

test("parseResourceLimits accepts safe overrides and rejects ambiguous values", () => {
  const limits = parseResourceLimits({
    COLLAB_MAX_CONNECTIONS_PER_ROOM: "8",
    COLLAB_MAX_MESSAGE_BYTES: "65536",
    COLLAB_MAX_UPDATE_BYTES: "32768",
    COLLAB_MAX_DOCUMENT_BYTES: "1000000",
    COLLAB_RATE_WINDOW_SECONDS: "5",
    COLLAB_MAX_MESSAGES_PER_WINDOW: "50",
    COLLAB_MAX_BYTES_PER_WINDOW: "2000000",
  });
  assert.equal(limits.maxConnectionsPerRoom, 8);
  assert.equal(limits.maxMessageBytes, 65_536);
  assert.equal(limits.maxUpdateBytes, 32_768);
  assert.equal(limits.rateWindowMilliseconds, 5_000);

  assert.throws(
    () => parseResourceLimits({ COLLAB_MAX_MESSAGE_BYTES: "1MB" }),
    /COLLAB_MAX_MESSAGE_BYTES/u
  );
  assert.throws(
    () =>
      parseResourceLimits({
        COLLAB_MAX_MESSAGE_BYTES: "65536",
        COLLAB_MAX_UPDATE_BYTES: "65537",
      }),
    /cannot exceed COLLAB_MAX_MESSAGE_BYTES/u
  );
  assert.throws(
    () =>
      parseResourceLimits({
        COLLAB_MAX_DOCUMENT_BYTES: "2000001",
      }),
    /COLLAB_MAX_DOCUMENT_BYTES/u
  );
  assert.throws(
    () =>
      parseResourceLimits({
        COLLAB_MAX_UPDATE_BYTES: "65537",
        COLLAB_MAX_DOCUMENT_BYTES: "65536",
      }),
    /cannot exceed COLLAB_MAX_DOCUMENT_BYTES/u
  );
});

test("messageByteLength counts binary views and UTF-8 strings", () => {
  assert.equal(messageByteLength(new Uint8Array([1, 2, 3])), 3);
  assert.equal(messageByteLength(new Uint16Array([1, 2, 3])), 6);
  assert.equal(messageByteLength(new ArrayBuffer(7)), 7);
  assert.equal(messageByteLength("collab-✓"), 10);
});

test("getYjsUpdate finds sync step-two and update payloads", () => {
  const update = Uint8Array.from([1, 2, 3, 4]);
  assert.deepEqual(getYjsUpdate(syncMessage(1, update)), update);
  assert.deepEqual(getYjsUpdate(syncMessage(2, update)), update);
  assert.equal(getYjsUpdate(syncMessage(0, update)), null);
  assert.equal(getYjsUpdate("__YPS:custom"), null);
});

test("getYjsUpdate fails closed for truncated or overlong update frames", () => {
  assert.throws(
    () => getYjsUpdate(Uint8Array.from([0, 2, 4, 1, 2])),
    (error) =>
      error instanceof ResourceLimitError &&
      error.code === "malformed_yjs_message"
  );
  assert.throws(
    () => getYjsUpdate(Uint8Array.from([0, 2, 1, 9, 9])),
    (error) =>
      error instanceof ResourceLimitError &&
      error.code === "malformed_yjs_message"
  );
});

test("consumeMessageBudget enforces count and bytes then resets the window", () => {
  const limits = {
    ...parseResourceLimits({}),
    rateWindowMilliseconds: 1_000,
    maxMessagesPerWindow: 2,
    maxBytesPerWindow: 10,
  };
  const first = consumeMessageBudget(null, limits, 4, 5_000);
  assert.equal(first.allowed, true);
  const second = consumeMessageBudget(first.state, limits, 6, 5_100);
  assert.equal(second.allowed, true);
  const countLimited = consumeMessageBudget(second.state, limits, 0, 5_200);
  assert.equal(countLimited.allowed, false);
  assert.equal(countLimited.reason, "message_rate_exceeded");

  const byteLimited = consumeMessageBudget(first.state, limits, 7, 5_200);
  assert.equal(byteLimited.allowed, false);
  assert.equal(byteLimited.reason, "byte_rate_exceeded");

  const reset = consumeMessageBudget(second.state, limits, 10, 6_001);
  assert.equal(reset.allowed, true);
  assert.equal(reset.state.messagesInWindow, 1);
});

test("hasConnectionCapacity counts the newly accepted candidate", () => {
  const limits = {
    ...parseResourceLimits({}),
    maxConnectionsPerRoom: 2,
  };
  assert.equal(hasConnectionCapacity(1, limits), true);
  assert.equal(hasConnectionCapacity(2, limits), true);
  assert.equal(hasConnectionCapacity(3, limits), false);
});

test("trySetConnectionState fails closed when the hibernation attachment is full", () => {
  const accepted = trySetConnectionState(
    { setState: (updater) => updater({ existing: true }) },
    (state) => ({ ...state, next: true })
  );
  assert.equal(accepted, true);

  const rejected = trySetConnectionState(
    {
      setState: () => {
        throw new Error("WebSocket attachment exceeds 2048 bytes");
      },
    },
    (state) => state
  );
  assert.equal(rejected, false);
});

test("restoreStoredDocumentState validates before mutating the live document", () => {
  const source = new Y.Doc();
  source.getText("content").insert(0, "persisted collaboration state");
  const validUpdate = Y.encodeStateAsUpdate(source);
  const restored = new Y.Doc();

  const result = restoreStoredDocumentState(restored, validUpdate, 65_536);
  assert.equal(result.ok, true);
  assert.equal(restored.getText("content").toString(), "persisted collaboration state");

  const untouched = new Y.Doc();
  untouched.getText("content").insert(0, "local sentinel");
  const before = Y.encodeStateAsUpdate(untouched);
  const corrupt = restoreStoredDocumentState(
    untouched,
    Uint8Array.from([255]),
    65_536
  );
  assert.deepEqual(corrupt, {
    ok: false,
    reason: "stored_document_corrupt",
    observed: 1,
  });
  assert.deepEqual(Y.encodeStateAsUpdate(untouched), before);

  const oversized = restoreStoredDocumentState(
    untouched,
    new Uint8Array(65_537),
    65_536
  );
  assert.deepEqual(oversized, {
    ok: false,
    reason: "stored_document_limit_exceeded",
    observed: 65_537,
    limit: 65_536,
  });
  assert.deepEqual(Y.encodeStateAsUpdate(untouched), before);
});
