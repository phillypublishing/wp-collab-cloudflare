import assert from "node:assert/strict";
import test from "node:test";

import {
  clearLegacyDocumentState,
  LEGACY_YJS_STATE_KEY,
} from "../src/ephemeral-relay.js";

test("clearLegacyDocumentState removes only the retired Yjs snapshot", async () => {
  const deleted = [];

  await clearLegacyDocumentState({
    delete: async (key) => {
      deleted.push(key);
      return true;
    },
  });

  assert.equal(LEGACY_YJS_STATE_KEY, "yjs-state-v1");
  assert.deepEqual(deleted, ["yjs-state-v1"]);
});

test("clearLegacyDocumentState fails closed when storage cannot be scrubbed", async () => {
  await assert.rejects(
    clearLegacyDocumentState({
      delete: async () => {
        throw new Error("storage unavailable");
      },
    }),
    /storage unavailable/
  );
});
