# Production readiness and operations

This runbook describes a guarded staging-to-production path. It does not make
the current proof of concept production-approved. Complete every release
blocker below before serving unpublished editor state outside a controlled
test environment.

## Release blockers

- The upstream project has no license. The owner must choose and add a license
  before redistribution or third-party production use. This repository does
  not infer one.
- There is no revision-aware generation/invalidation protocol between
  WordPress and retained Yjs state. Decide which WordPress events create a new
  collaboration generation, what happens on revision restore and out-of-band
  mutation, and whether pending collaborators may finish before invalidation.
- There is no authenticated operator endpoint that can export, quarantine,
  replace, or delete one corrupt room. Do not delete Durable Object storage to
  make a load error disappear. Build and audit an explicit recovery path first.
- A retention duration and legal/data-governance owner have not been selected.
  Do not implement time-based deletion until the invalidation and recovery
  contracts identify which state is safe to remove.
- Load-test the configured limits with representative Gutenberg documents and
  peak collaborator counts. The checked-in values are conservative starting
  bounds, not capacity promises.
- Select an edge abuse-control policy for unauthenticated upgrade attempts.
  Per-connection limits begin after a credential reaches its room and do not
  replace Cloudflare WAF/rate-limiting controls on the public Worker route.

## Environment model

Wrangler creates isolated `staging` and `production` Workers. Variables and
Durable Object bindings are repeated intentionally because Wrangler does not
inherit either into named environments. Each environment gets its own Durable
Object namespace and `COLLAB_AUTH_KEYS` secret.

The application limits are public Wrangler variables:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `COLLAB_MAX_CONNECTIONS_PER_ROOM` | 20 | Accepted WebSockets in one room, including the new candidate |
| `COLLAB_MAX_MESSAGE_BYTES` | 1,048,576 | Maximum WebSocket frame payload |
| `COLLAB_MAX_UPDATE_BYTES` | 524,288 | Maximum Yjs sync step-two/update payload |
| `COLLAB_MAX_DOCUMENT_BYTES` | 1,500,000 | Maximum compact merged Yjs update stored for a room |
| `COLLAB_RATE_WINDOW_SECONDS` | 10 | Fixed per-connection rate window |
| `COLLAB_MAX_MESSAGES_PER_WINDOW` | 200 | Frames per connection per window |
| `COLLAB_MAX_BYTES_PER_WINDOW` | 4,194,304 | Aggregate bytes per connection per window |

Invalid or contradictory values return a generic `503` before routing. A
limit violation closes only the offending connection with application close
code `4008`; the WordPress provider treats that code as terminal, stops
reconnecting, and leaves a persistent editor notice. Authentication expiry
uses code `4001` and remains reconnectable so a fresh credential can be minted.
Existing oversized or corrupt stored state is preserved and the room refuses
to load; raise an intentionally lowered limit or use the future
operator-reviewed export/quarantine/reset procedure.

## First staging deployment

1. Create a random installation ID and at least one 32-byte random signing
   secret. Encode them using base64url-safe characters.
2. Create a keyring file outside the repository. The legacy format remains
   accepted:

   ```json
   {"YOUR_SITE_ID":"YOUR_SIGNING_SECRET"}
   ```

   New installations should start with a named key:

   ```json
   {"YOUR_SITE_ID":{"keys":{"2026-08":"YOUR_SIGNING_SECRET"}}}
   ```

3. Authenticate Wrangler or set a narrowly scoped `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`. Never put either value in this repository.
4. Run `npm ci`, `npm run check`, then configure the secret interactively:

   ```bash
   npx wrangler secret put COLLAB_AUTH_KEYS --env staging
   npm run deploy:staging
   ```

5. Confirm `https://<staging-worker>/` returns `status: ok`. Configure a
   staging WordPress site with the matching site ID, secret, Worker WSS URL,
   and `WP_COLLAB_CF_AUTH_KEY_ID` when using a named key.
6. Run two independent editor sessions through connect, convergence, forced
   reconnect, credential refresh, and Worker restart. Confirm permission
   denial and limit rejection cases before promoting the exact commit.

Production uses the same sequence with `--env production`. Deployment is a
manual, separately authorized action; CI only builds a dry-run bundle.

## Zero-downtime signing-key rotation

The Worker accepts either the original string entry or a rotation object:

```json
{
  "YOUR_SITE_ID": {
    "legacy": "OLD_KEY_WITHOUT_A_KEY_ID",
    "keys": {
      "2026-08": "CURRENT_KEY",
      "2026-11": "NEXT_KEY"
    }
  }
}
```

For a legacy installation:

1. Deploy the Worker secret with the old value in `legacy` and the next value
   under a new key ID.
2. Set WordPress's `WP_COLLAB_CF_AUTH_SECRET` to the next value and
   `WP_COLLAB_CF_AUTH_KEY_ID` to its ID.
3. Wait at least 330 seconds (the maximum 300-second grant plus clock skew),
   and verify all reconnects mint the named key.
4. Remove `legacy` from the Worker secret.

For subsequent rotations, keep current and next IDs in `keys`, switch the two
WordPress constants, wait at least 330 seconds, then remove the retired ID.
Never reuse a key ID with different material. Roll back by restoring the prior
WordPress ID/secret while its Worker key remains present.

## Logs and alerts

The Worker emits JSON events containing only the service name, event code,
status, observed size, and configured limit. It deliberately excludes URLs,
headers, room names, user IDs, origins, credential claims, and message content.

Alert on sustained `configuration_invalid`, `auth_unavailable`,
`stored_document_limit_exceeded`, `stored_document_corrupt`,
`document_limit_exceeded_during_save`, and bursts of
connection/message/update/rate-limit events. Dashboard request logs,
Logpush, traces, proxies, and SIEM pipelines must not record
`Sec-WebSocket-Protocol`: it temporarily contains the bearer credential at the
edge even though the Worker strips it before Durable Object routing. Keep log
retention no longer than the incident-response policy requires.

Apply an account-level rate-limit rule to repeated failed upgrade attempts,
but key it on an appropriate network signal rather than credentials, room
names, or user IDs. Tune and validate that rule in staging; NAT and enterprise
egress make a universal per-IP threshold unsafe to infer here.

Cloudflare notes that `wrangler tail` holds WebSocket request logs until the
socket closes and should not be attached to a high-volume Worker. Prefer
sampled observability and bounded incident windows.

## State recovery and retention

WordPress is authoritative for saved posts; the Durable Object update exists
only for live collaboration continuity. Until operator tooling exists:

1. Treat a corrupt/load-failing room as an incident and prevent reconnect
   loops at WordPress.
2. Record the Worker version, environment, Durable Object identifier, room
   generation, timestamps, and related WordPress revision without recording
   credentials or editor content in general logs.
3. Preserve the original storage value. Do not automatically replace it with
   an empty Yjs update and do not delete the whole namespace.
4. Recover against a duplicate, access-controlled environment only after the
   content owner approves inspection of unpublished state.
5. Restore service by a reviewed generation change or explicit room reset only
   after WordPress authority and collaborator impact are resolved.

A future operator endpoint must require distinct administrative
authentication, provide export-before-mutation, write an immutable audit
record, support quarantine rather than silent deletion, and target one exact
site/blog/object/generation. The same generation contract must define
retention. Candidate triggers requiring a product decision are post save,
autosave, revision restore, trash/delete, post-type change, multisite deletion,
and edits performed outside the block editor.

## Rollback

- Roll back code with Wrangler's version/rollback workflow only after checking
  that the target version understands the existing Durable Object schema and
  credential format.
- Keep the current and previous verification keys during rollback windows.
- A code rollback must never delete or recreate the Durable Object namespace.
- If a new limit rejects valid documents, restore the previous limit first;
  the room state was preserved.
- After rollback, repeat authenticated connect/reconnect/convergence checks and
  review the redacted security-event rate.

## Primary references

- [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/)
- [Durable Object environments](https://developers.cloudflare.com/durable-objects/reference/environments/)
- [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Durable Object known issues](https://developers.cloudflare.com/durable-objects/platform/known-issues/)
