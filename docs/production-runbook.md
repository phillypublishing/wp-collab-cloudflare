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
- Bound collection credential issuance and room cardinality. Core authorizes
  `root` and `taxonomy` collections by kind rather than validating every entity
  name, so an `edit_posts` user can mint many distinct rooms and spread traffic
  across per-room limits. Choose and test an issuance rate limit, a
  registered-entity policy, or both without removing the documented custom
  collection extension seam.

## Environment model

Wrangler creates isolated `staging` and `production` Workers. Variables and
Durable Object bindings are repeated intentionally because Wrangler does not
inherit either into named environments. Each environment gets its own Durable
Object namespace and `COLLAB_AUTH_KEYS` secret.

The top-level Wrangler configuration is local-only. Its custom build guard
rejects unqualified deployment commands so `wp-collab-cloudflare` cannot be
recreated accidentally; use `npm run deploy:staging` or
`npm run deploy:production` for every remote deployment.

The named environments publish stable `workers.dev` routes and disable
per-version preview aliases. Production source promotion is an explicit
GitHub Actions deployment from a full commit SHA already merged to `main`.
Neither an ordinary `main` push nor a mutable release branch deploys
production.

The application limits are public Wrangler variables:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `COLLAB_MAX_CONNECTIONS_PER_ROOM` | 20 | Accepted WebSockets in one room, including the new candidate |
| `COLLAB_CONNECTION_TIMEOUT_SECONDS` | 14,400 | Established WebSocket lifetime, independent of the short-lived connection grant |
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
reconnecting, and leaves a persistent editor notice. Session timeout uses code
`4001` and remains reconnectable so a fresh credential can be minted.
Deploying this model may cause one final reconnect for sockets carrying the
legacy credential-expiry attachment; subsequent connections use the
independent session timeout.

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

   The checked-in staging environment publishes one stable `workers.dev`
   route and disables per-version preview URLs. This keeps the Origin and
   operator validation surface unambiguous.

5. Confirm `https://<staging-worker>/` returns `status: ok`. Configure a
   staging WordPress site with the matching site ID, secret, Worker WSS URL,
   and `WP_COLLAB_CF_AUTH_KEY_ID` when using a named key.
6. Run two independent editor sessions through connect and convergence. Keep
   both open past the grant lifetime and confirm no socket, presence, or
   credential rotation occurs. Then force a reconnect and confirm a fresh
   credential is obtained. Save a non-baseline edit, confirm
   `_crdt_document` exists in WordPress, disconnect every client, restart the
   Worker, and confirm a new editor hydrates that state from WordPress. Also
   confirm a raw Worker-only probe is absent after restart, plus permission
   denial and limit rejection cases, before promoting the exact commit.

The WordPress operator can run the independent
[staging-site checklist](staging-site-validation.md) without Cloudflare or
server-shell access. Use the CI-built plugin ZIP for the exact commit containing
the approved plugin source rather than copying a mutable source checkout. Record
that plugin commit separately when the deployed Worker uses a later commit.

## First production bootstrap

Cloudflare needs the named Worker before it can attach the first secret. Do
this once from the exact reviewed `main` commit while no WordPress site points
at the production endpoint:

1. Run `npm ci`, `npm run check`, and `npm run deploy:production`. The Worker
   fails closed until its keyring exists.
2. Generate a new production-only site ID and signing secret. Store a named
   keyring with `npx wrangler secret put COLLAB_AUTH_KEYS --env production`.
   `wrangler secret put` creates and immediately deploys a new Worker version.
3. Confirm the production HTTPS root returns
   `{"status":"ok","service":"wp-collab-cloudflare"}` before configuring
   WordPress.
4. Create the repository's `production` GitHub environment. Restrict it to
   workflow runs from `main`, configure an explicit reviewer when the GitHub
   plan permits one, add `CLOUDFLARE_API_TOKEN` as an environment secret, and
   set these environment variables:

   - `CLOUDFLARE_ACCOUNT_ID`
   - `WORKER_HEALTH_URL` (the HTTPS root without a trailing slash)

Keep `COLLAB_AUTH_KEYS` out of GitHub. It belongs only in Cloudflare and in the
private WordPress configuration that holds the matching site credential.

## Production promotion workflow

Run **Production Worker deploy** manually and provide the full lowercase
40-character commit SHA to promote. The workflow fails closed unless that
revision is reachable from `main`, the complete Worker check passes, the
production keyring already exists, the named production deployment succeeds,
and its health response is valid. The workflow input and job summary record the
promoted revision; GitHub's production environment serializes concurrent
promotion attempts.

To roll back Worker code, dispatch the same workflow with the prior known-good
commit SHA. Secret rotation remains a separate operation and does not occur as
a side effect of source promotion.

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

### WordPress credential timing

Set `WP_COLLAB_CF_LOG_CREDENTIAL_REQUESTS` to `true` in the private WordPress
configuration MU-plugin. The plugin then writes one structured record to the
PHP error log for every `/wp-json/wp-collab-cf/v1/token` callback:

```json
{"schema":"wp-collab-cf-credential/v1","event":"credential_request","status":"issued","durationMs":24,"httpStatus":200,"siteId":"example-site","blogId":"1","objectType":"postType/post","objectId":"305806","userId":"17"}
```

Errors use `status: error` and add a bounded `errorCode`. Records never contain
the credential, signing key, room, content, request body, headers, client IP,
or raw error message. Disable the constant or return `false` from the
`wp_collab_cf_log_credential_requests` filter to stop this sink.

These records measure the WordPress callback, including permission checks and
credential signing. Cookie or nonce failures rejected before the callback are
visible only in the web server or WordPress REST access logs. Correlate PHP and
Worker records by timestamp plus site, blog, object, and user IDs; a request
that has a PHP record but no subsequent Worker open event failed between
credential issuance and the WebSocket upgrade. Keep this private log's
retention bounded by the incident-response policy.

### Worker connection lifecycle

The Worker keeps authentication failures and resource-limit events aggregate,
but emits attributable JSON lifecycle events after authentication succeeds.
Named staging and production environments set Workers Logs head sampling to
`1`, so an individual open, close, or runtime error is not intentionally
discarded before ingestion.

`connection_opened`, `connection_closed`, and `connection_error` contain the
verified site ID, blog ID, object type, object/post ID, WordPress user ID, room,
server-generated connection correlation ID, connection duration, and room
connection count.
Close events also include the numeric close code, a bounded status, and
`wasClean`. The Worker never logs the bearer token, signing key, request
headers, Origin, document content, Yjs messages, raw exception text, or raw
client-supplied close reason.

These identifiers come only from a successfully verified WordPress credential.
The edge handler strips the credential-bearing subprotocol, replaces any
client-supplied internal identity headers with the verified values, and stores
that bounded identity in the hibernating WebSocket attachment for later close
and error events. Failed authentication cannot create attributable lifecycle
records from untrusted claims.

Named staging and production deployments also bind isolated Workers Analytics
Engine datasets named `wp_collab_cloudflare_staging` and
`wp_collab_cloudflare_production`. Local development has no analytics binding.
Metrics are best-effort: a missing binding or failed write cannot alter an auth
decision, WebSocket upgrade, or resource-limit close. Analytics Engine may
sample stored data independently of Workers Logs; lifecycle rows use a
server-generated connection correlation ID as their sampling index so events
from one socket remain correlatable without trusting PartyServer's
client-selectable `_pk` value.

The aggregate schema remains backward compatible in its first fields. Lifecycle
events extend it with reviewed, bounded operational identifiers:

| Column | Meaning |
| --- | --- |
| `index1` | Constant `wp-collab-cloudflare` for aggregate events; server-generated connection correlation ID for lifecycle events |
| `blob1` | Allowlisted event, including `connection_opened`, `connection_closed`, and `connection_error` |
| `blob2` | Allowlisted status or rejection/limit code |
| `blob3` | Verified site ID for lifecycle events |
| `blob4` | Verified WordPress blog ID for lifecycle events |
| `blob5` | Verified Gutenberg object type, such as `postType/post` |
| `blob6` | Verified object/post ID, or `collection` |
| `blob7` | Verified WordPress user ID |
| `blob8` | Verified room ID |
| `blob9` | Server-generated connection correlation ID |
| `double1` | Event count, always `1` |
| `double2` | Non-negative observed byte/connection count when applicable, otherwise `0` |
| `double3` | Non-negative configured limit when applicable, otherwise `0` |
| `double4` | WebSocket close code for close events |
| `double5` | Connection duration in milliseconds |
| `double6` | `1` when a close was clean, otherwise `0` |
| `double7` | Room connection count observed at the lifecycle boundary |

Keep this schema closed; use `unknown` for any identifier or code that does not
match its reviewed shape. Never add arbitrary request strings, error messages,
or close reasons as labels.

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

For an editor incident, query a specific post ID and inspect the socket sequence:

```sql
SELECT
  timestamp,
  blob1 AS event,
  blob2 AS status,
  blob3 AS site_id,
  blob4 AS blog_id,
  blob5 AS object_type,
  blob6 AS object_id,
  blob7 AS user_id,
  blob8 AS room_id,
  blob9 AS connection_id,
  double4 AS close_code,
  double5 AS duration_ms,
  double6 AS was_clean,
  double7 AS room_connection_count
FROM wp_collab_cloudflare_production
WHERE timestamp > NOW() - INTERVAL '1' HOUR
  AND blob1 IN ('connection_opened', 'connection_closed', 'connection_error')
  AND blob6 = '305806'
ORDER BY timestamp ASC
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
socket closes and should not be attached to a high-volume Worker. Use bounded
incident windows and keep attributable log retention no longer than the
operator's incident-response policy requires.

## Ephemeral room lifecycle

The Worker stores no Yjs document bytes. A room remains in memory while peers
are connected, and connected clients re-sync it after hibernation. When the
final WebSocket closes, the Worker calls YServer's `resetDocument()` lifecycle
seam: pending saves are flushed, the old Y.Doc and awareness state are
destroyed, and a fresh document is initialized through `onLoad()`. For this
ephemeral relay, `onLoad()` restores no document bytes, so a later editor starts
empty and Gutenberg loads the durable CRDT snapshot and current entity values
from WordPress.

The reset refuses to run while another connection remains. Ordinary workerd QA
proves the boundary for both normal and abnormal final-peer closes, proves the
first of multiple peers cannot reset shared state, and proves the fresh room
accepts WordPress rehydration. The same behavior also follows Worker restart or
Durable Object eviction.

This applies equally to collection rooms. Their Yjs document carries only a
lightweight invalidation signal; authoritative records remain in WordPress and
are refetched through REST. Restart verification seeds a uniquely named
synthetic collection room and proves its relay-only state is not restored. The
global `root/comment` room is unsuitable for that destructive restart check
because an unrelated open editor could reconnect and rehydrate the probe.

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
