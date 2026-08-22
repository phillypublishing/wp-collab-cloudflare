if (process.env.WRANGLER_COMMAND !== "dev") {
  console.error(
    "Default Worker deployments are disabled. Use npm run deploy:staging or npm run deploy:production."
  );
  process.exitCode = 1;
}
