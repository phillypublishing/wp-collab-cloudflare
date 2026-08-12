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

test("named deployments bind isolated Analytics Engine datasets", async () => {
  const config = await readFile(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(
    config.slice(0, config.indexOf('"env"')),
    /"analytics_engine_datasets"/u,
    "local development has no Analytics Engine binding"
  );
  assert.match(
    config,
    /"staging"[\s\S]*?"analytics_engine_datasets"[\s\S]*?"binding":\s*"COLLAB_METRICS"[\s\S]*?"dataset":\s*"wp_collab_cloudflare_staging"/u
  );
  assert.match(
    config,
    /"production"[\s\S]*?"analytics_engine_datasets"[\s\S]*?"binding":\s*"COLLAB_METRICS"[\s\S]*?"dataset":\s*"wp_collab_cloudflare_production"/u
  );
});
