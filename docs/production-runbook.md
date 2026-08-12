# Production readiness and operations

This runbook describes a guarded staging-to-production path. It does not make
the current proof of concept production-approved. Complete every release
blocker below before serving unpublished editor state outside a controlled
test environment.

## Release blockers

- The upstream project has no license. The owner must choose and add a license
  before redistribution or third-party production use. This repository does
  not infer one.
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
| `COLLAB_MAX_MESSAGE_BYTES` | 1,572,864 | Maximum WebSocket frame payload, including protocol overhead |
| `COLLAB_MAX_UPDATE_BYTES` | 1,500,000 | Maximum Yjs sync step-two/update payload; keep equal to the document limit so WordPress can hydrate an empty relay |
| `COLLAB_MAX_DOCUMENT_BYTES` | 1,500,000 | Maximum compact merged Yjs update held in memory for a room |
| `COLLAB_RATE_WINDOW_SECONDS` | 10 | Fixed per-connection rate window |
| `COLLAB_MAX_MESSAGES_PER_WINDOW` | 200 | Frames per connection per window |
| `COLLAB_MAX_BYTES_PER_WINDOW` | 4,194,304 | Aggregate bytes per connection per window |

`COLLAB_MAX_UPDATE_BYTES` must equal `COLLAB_MAX_DOCUMENT_BYTES`, and
`COLLAB_MAX_MESSAGE_BYTES` must leave room for the Yjs sync frame around that
document. Invalid combinations fail closed at Worker startup.

Invalid or contradictory values return a generic `503` before routing. A
limit violation closes only the offending connection with application close
code `4008`; the WordPress provider treats that code as terminal, stops
reconnecting, and leaves a persistent editor notice. Authentication expiry
uses code `4001` and remains reconnectable so a fresh credential can be minted.

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
   reconnect, and credential refresh. Save a non-baseline edit, confirm
   `_crdt_document` exists in WordPress, disconnect every client, restart the
   Worker, and confirm a new editor hydrates that state from WordPress. Also
   confirm a raw Worker-only probe is absent after restart, plus permission
   denial and limit rejection cases, before promoting the exact commit.

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

Named staging and production deployments also bind isolated Workers Analytics
Engine datasets named `wp_collab_cloudflare_staging` and
`wp_collab_cloudflare_production`. Local development has no analytics binding.
Metrics are best-effort: a missing binding or failed write cannot alter an auth
decision, WebSocket upgrade, or resource-limit close.

The dataset schema is intentionally count-only and closed to request-derived
labels:

| Column | Meaning |
| --- | --- |
| `index1` | Constant sampling key `wp-collab-cloudflare` |
| `blob1` | Allowlisted event: `configuration_invalid`, `connection_accepted`, `connection_rejected`, or `resource_limit` |
| `blob2` | Allowlisted status or rejection/limit code |
| `double1` | Event count, always `1` |
| `double2` | Non-negative observed byte/connection count when applicable, otherwise `0` |
| `double3` | Non-negative configured limit when applicable, otherwise `0` |

No metric contains a URL, room, site, blog, user, token, origin, header,
document content, or raw request value. Keep this schema closed; use `unknown`
for a newly encountered code until it has been reviewed and explicitly added.

After a staging deployment has produced data, use an Account Analytics Read
token with Cloudflare's Analytics Engine SQL API. This dashboard query shows
sample-aware five-minute event counts:

```sql
SELECT
  toStartOfInterval(timestamp, INTERVAL '5' MINUTE) AS bucket,
  blob1 AS event,
  blob2 AS status,
  SUM(_sample_interval * double1) AS event_count
FROM wp_collab_cloudflare_staging
WHERE timestamp > NOW() - INTERVAL '1' DAY
GROUP BY bucket, event, status
ORDER BY bucket ASC, event ASC, status ASC
```

This query supports a resource-pressure panel without adding room labels:

```sql
SELECT
  blob2 AS limit_code,
  SUM(_sample_interval * double1) AS event_count,
  MAX(double2) AS max_observed,
  MAX(double3) AS configured_limit
FROM wp_collab_cloudflare_staging
WHERE timestamp > NOW() - INTERVAL '1' HOUR
  AND blob1 = 'resource_limit'
GROUP BY limit_code
ORDER BY event_count DESC
```

Start with two deterministic alert signals: any `configuration_invalid` or
`auth_unavailable` event in five minutes. For resource and ordinary auth-reject
bursts, establish a staging baseline before selecting a threshold; do not copy
an arbitrary production threshold into this proof of concept. Replace the
dataset name with `wp_collab_cloudflare_production` only after the production
deployment gate is approved. These bindings, queries, and alert candidates are
configuration and runbook work only; no Cloudflare deployment or live dataset
write has been validated in this repository.

```sql
SELECT
  blob1 AS event,
  blob2 AS status,
  SUM(_sample_interval * double1) AS event_count
FROM wp_collab_cloudflare_staging
WHERE timestamp > NOW() - INTERVAL '5' MINUTE
  AND (
    blob1 = 'configuration_invalid'
    OR blob2 = 'auth_unavailable'
  )
GROUP BY event, status
HAVING event_count > 0
```

Use the baseline to add burst alerts for connection/message/update/rate-limit
events. Dashboard request logs,
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

## Ephemeral room lifecycle

The Worker stores no Yjs document bytes. A room may remain in memory while its
Durable Object instance is live, and connected clients re-sync it after
hibernation. Once no client can provide state and the Worker restarts or the
instance is evicted, the relay starts empty. Gutenberg then loads the durable
CRDT snapshot and current entity values from WordPress.

The `onLoad()` hook deletes the exact legacy `yjs-state-v1` key used by earlier
versions. This cleans active historical rooms without touching alarms or
hibernating WebSocket attachments. Inactive legacy room values cannot be
enumerated through a Durable Object namespace; after the migration window,
delete the retired environment or namespace through a separately reviewed
account operation if complete historical erasure is required.

## Rollback

- Roll back code with Wrangler's version/rollback workflow only after checking
  that the target version understands the credential format. Rolling back to a
  persistence-writing version reintroduces the dual-authority design and
  requires an explicit decision.
- Keep the current and previous verification keys during rollback windows.
- A code rollback must never delete or recreate the Durable Object namespace.
- After rollback, repeat authenticated connect/reconnect/convergence checks and
  review the redacted security-event rate.

## Primary references

- [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/)
- [Durable Object environments](https://developers.cloudflare.com/durable-objects/reference/environments/)
- [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Durable Object known issues](https://developers.cloudflare.com/durable-objects/platform/known-issues/)
- [Workers Analytics Engine setup](https://developers.cloudflare.com/analytics/analytics-engine/get-started/)
- [Workers Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)
