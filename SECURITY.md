# Security model

The collaboration Worker handles unpublished editor state. Treat it as an
authenticated application service, not as a public WebSocket relay.

## Trust boundaries

- WordPress is authoritative for user identity, `edit_post` authorization,
  saved post content, revisions, and autosaves.
- The Worker is authoritative only for admitting WebSocket connections and
  relaying/persisting the transient Yjs room state.
- WordPress and the Worker share a random HMAC key for one stable installation
  identifier. The key is never localized into browser JavaScript.
- TLS (`https:`/`wss:`) is required outside a loopback or encrypted local
  development network.

The browser requests a credential from `wp-collab-cf/v1/token` through Core's
`wp.apiFetch`, which supplies the normal WordPress login cookie and REST nonce
and refreshes an expired nonce using WordPress's supported flow. WordPress
verifies `edit_post` for the specific post and returns a 30-300 second HMAC
credential (60 seconds by default). It is scoped to the user, installation,
multisite blog, editor Origin, object type/ID, and exact Durable Object room.

The Worker verifies the HMAC, audience, timestamps, known installation key,
exact signed Origin, and exact room before PartyServer allocates or joins a
Durable Object. The browser carries the credential in the
`Sec-WebSocket-Protocol` header, never in the URL. The Worker strips that
credential header before forwarding the request, and a Durable Object alarm
closes the connection when the signed lifetime expires. The provider then
reconnects with a newly requested WordPress credential.

Room names are not secrets. Their format includes the installation ID and
WordPress blog ID before the object type and ID, preventing collisions between
installations and between blogs in one multisite network.

## Persistence authority

The Durable Object stores a compact Yjs update through `onSave()` and restores
it through `onLoad()`. This survives Worker eviction and Wrangler/Worker
restarts. It is collaboration continuity, not an independent post backup.
WordPress remains the source of truth for saved content.

There is currently no revision-aware invalidation protocol between WordPress
and the Durable Object. Restoring an old WordPress revision or changing content
out of band can therefore merge with retained Yjs state when that room is next
opened. Do not use the stored update as a canonical record, and define an
invalidation/generation policy before long-lived production retention.

## Deliberate compatibility break

Version 0.2 rejects the old unauthenticated room URLs. It supports secured
`postType/<post-type>` objects with a positive post ID and fails closed for
collection or unknown entity rooms because they need their own WordPress
capability model. There is no insecure compatibility flag.

## Residual risks

- A stolen credential can be replayed from a non-browser client until it
  expires; Origin is defense in depth, not proof of browser identity.
- A compromised WordPress installation or HMAC key can mint grants for that
  installation. The keyring supports named overlapping keys plus an explicit
  legacy bridge; follow the staged rotation procedure rather than replacing a
  live key in one step.
- Snapshot saves are debounced (250 ms, at most 1 second), leaving a small
  crash-loss window. Storage failures are logged by `y-partyserver` but do not
  block live editing.
- The credential necessarily reaches Cloudflare's edge in a request header.
  Do not enable request-header logging or copy `Sec-WebSocket-Protocol` into
  custom logs. The Worker strips it before Durable Object forwarding, but
  account-level log/trace products must also be configured to redact it.
- A corrupt or over-limit stored Yjs update makes room loading fail. It is not
  discarded automatically because silent reset could lose unpublished work;
  recovery requires an explicit operator-reviewed storage reset. A versioned
  quarantine/reset workflow remains production work.
- The Worker enforces configurable connection, message, Yjs update,
  merged-document, message-rate, and byte-rate limits below Cloudflare's
  platform ceilings. These defaults still require representative load tests
  and alert thresholds before production.

The [production runbook](docs/production-runbook.md) records the rollout,
rotation, log-redaction, rollback, and state-recovery procedures plus release
blockers. In particular, the project still needs an explicit license,
revision-aware generation/invalidation semantics, authenticated operator
recovery tooling, and an approved retention policy.
