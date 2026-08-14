import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const wranglerConfig = readFile(
  new URL("../wrangler.jsonc", import.meta.url),
  "utf8"
).then((source) => JSON.parse(source.replace(/^\s*\/\/.*$/gmu, "")));

test("staging setup writes the secret to the named Wrangler environment", async () => {
  const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");

  assert.match(
    readme,
    /wrangler secret put COLLAB_AUTH_KEYS --env staging/u
  );
});

test("named deployments bind isolated Analytics Engine datasets", async () => {
  const config = await wranglerConfig;

  assert.equal(
    config.analytics_engine_datasets,
    undefined,
    "local development has no Analytics Engine binding"
  );
  assert.deepEqual(
    config.env.staging.analytics_engine_datasets,
    [
      {
        binding: "COLLAB_METRICS",
        dataset: "wp_collab_cloudflare_staging",
      },
    ]
  );
  assert.deepEqual(
    config.env.production.analytics_engine_datasets,
    [
      {
        binding: "COLLAB_METRICS",
        dataset: "wp_collab_cloudflare_production",
      },
    ]
  );
});

test("every deployment separates four-hour sessions from short-lived grants", async () => {
  const config = await wranglerConfig;

  assert.equal(config.vars.COLLAB_CONNECTION_TIMEOUT_SECONDS, "14400");
  assert.equal(
    config.env.staging.vars.COLLAB_CONNECTION_TIMEOUT_SECONDS,
    "14400"
  );
  assert.equal(
    config.env.production.vars.COLLAB_CONNECTION_TIMEOUT_SECONDS,
    "14400"
  );
});

test("staging publishes one stable workers.dev route without preview aliases", async () => {
  const config = await wranglerConfig;

  assert.equal(config.env.staging.workers_dev, true);
  assert.equal(config.env.staging.preview_urls, false);
});
