import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("staging setup writes the secret to the named Wrangler environment", async () => {
  const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");

  assert.match(
    readme,
    /wrangler secret put COLLAB_AUTH_KEYS --env staging/u
  );
});
