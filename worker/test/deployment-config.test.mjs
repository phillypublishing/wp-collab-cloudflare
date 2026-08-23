import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const wranglerConfig = readFile(
  new URL("../wrangler.jsonc", import.meta.url),
  "utf8"
).then((source) => JSON.parse(source.replace(/^\s*\/\/.*$/gmu, "")));

const deploymentGuard = fileURLToPath(
  new URL("../scripts/guard-default-deploy.mjs", import.meta.url)
);
const workerDirectory = fileURLToPath(new URL("..", import.meta.url));
const wranglerCli = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)
);

test("staging setup writes the secret to the named Wrangler environment", async () => {
  const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");

  assert.match(
    readme,
    /wrangler secret put COLLAB_AUTH_KEYS --env staging/u
  );
});

test("the default Worker environment cannot be deployed", async () => {
  const config = await wranglerConfig;

  assert.equal(
    config.build.command,
    "node scripts/guard-default-deploy.mjs"
  );
  assert.deepEqual(config.env.staging.build, {});
  assert.deepEqual(config.env.production.build, {});

  const outputDirectory = mkdtempSync(
    join(tmpdir(), "wp-collab-default-deploy-")
  );
  const environment = {
    ...process.env,
    WRANGLER_SEND_METRICS: "false",
  };
  delete environment.CLOUDFLARE_ENV;
  delete environment.WRANGLER_COMMAND;

  let blocked;
  try {
    blocked = spawnSync(
      process.execPath,
      [wranglerCli, "deploy", "--dry-run", "--outdir", outputDirectory],
      {
        cwd: workerDirectory,
        encoding: "utf8",
        env: environment,
      }
    );
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }

  assert.notEqual(blocked.status, 0);
  assert.match(
    `${blocked.stdout}\n${blocked.stderr}`,
    /Default Worker deployments are disabled/u
  );

  const localDevelopment = spawnSync(process.execPath, [deploymentGuard], {
    encoding: "utf8",
    env: { ...process.env, WRANGLER_COMMAND: "dev" },
  });

  assert.equal(localDevelopment.status, 0, localDevelopment.stderr);
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

test("named deployments publish stable workers.dev routes without preview aliases", async () => {
  const config = await wranglerConfig;

  assert.equal(config.env.staging.workers_dev, true);
  assert.equal(config.env.staging.preview_urls, false);
  assert.equal(config.env.production.workers_dev, true);
  assert.equal(config.env.production.preview_urls, false);
});
