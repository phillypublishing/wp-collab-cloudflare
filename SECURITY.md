# Security model

The collaboration Worker handles unpublished editor state. Treat it as an
authenticated application service, not as a public WebSocket relay.

## Trust boundaries

- WordPress is authoritative for user identity, `edit_post` authorization,
  saved post content, revisions, and autosaves.
- The Worker is authoritative only for admitting WebSocket connections and
  relaying transient Yjs room state while clients are active.
- WordPress and the Worker share a random HMAC key for one stable installation
  identifier. The key is never localized into browser JavaScript.
- TLS (`https:`/`wss:`) is required outside a loopback or encrypted local
  development network.

The browser requests a credential from `wp-collab-cf/v1/token` through Core's
`wp.apiFetch`, which supplies the normal WordPress login cookie and REST nonce
and refreshes an expired nonce using WordPress's supported flow. WordPress
verifies `edit_post` for a specific post, or Gutenberg's collection sync
permission behind an `edit_posts` minimum, and returns a 30-300 second HMAC
credential (60 seconds by default). It is scoped to the user, installation,
multisite blog, editor Origin, object type/ID (or internal `collection`
sentinel), and exact Durable Object room.

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

The Durable Object never writes Yjs document bytes to storage. Its `onLoad()`
hook deletes the retired `yjs-state-v1` value from rooms created by older
versions, then starts with an empty in-memory document. Alarms and hibernating
WebSocket attachments remain durable because they enforce connection expiry;
they do not contain the shared document.

Gutenberg persists the CRDT snapshot in WordPress's `_crdt_document` post meta.
That WordPress record, normal post fields, revisions, and autosaves are the
durable authority. Connected clients re-sync an empty relay after Durable
Object hibernation. If every client disconnects and the Worker restarts, a new
editor session hydrates from WordPress instead of Worker storage. Consequently,
revision restores and out-of-band WordPress changes follow Gutenberg's own CRDT
reconciliation rather than competing with a second durable snapshot.

## Collection authorization

The browser sends an actual JSON null for a Gutenberg collection. It cannot
submit `collection` as an object ID; that sentinel exists only inside the
signed room name. Collection types accept a bounded, slash-safe `kind/name`
shape so custom Gutenberg entities can reach WordPress authorization. The
default decision comes from `WP_Sync_Config`, which covers Core postType,
root, and taxonomy collections and denies unknown kinds. Sites can opt a
custom kind in, or narrow Core's result, with
`wp_collab_cf_collection_sync_permission`. That filter receives the proposed
boolean, entity kind, entity name, and null object ID. It always runs after
authentication and the minimum `edit_posts` capability, so it cannot create an
anonymous or subscriber-accessible room.

## Deliberate compatibility break

Version 0.2 rejects the old unauthenticated room URLs. It supports secured
`postType/<post-type>` objects with a positive post ID and authorized
collections using an internal `collection` sentinel. Unsupported
non-collection entities still fail closed. There is no insecure compatibility
flag.

## Residual risks

- A stolen credential can be replayed from a non-browser client until it
  expires; Origin is defense in depth, not proof of browser identity.
- A compromised WordPress installation or HMAC key can mint grants for that
  installation. The keyring supports named overlapping keys plus an explicit
  legacy bridge; follow the staged rotation procedure rather than replacing a
  live key in one step.
- Unsaved collaboration durability depends on Gutenberg successfully persisting
  `_crdt_document` to WordPress or on at least one connected client retaining
  the state. The Worker is intentionally not an independent recovery store.
- The credential necessarily reaches Cloudflare's edge in a request header.
  Do not enable request-header logging or copy `Sec-WebSocket-Protocol` into
  custom logs. The Worker strips it before Durable Object forwarding, but
  account-level log/trace products must also be configured to redact it.
- The Worker enforces configurable connection, message, Yjs update,
  merged-document, message-rate, and byte-rate limits below Cloudflare's
  platform ceilings. These defaults still require representative load tests
  and alert thresholds before production.
- Core's collection permission is kind-level for `root` and `taxonomy`; it does
  not prove each requested entity name is registered. An authenticated user
  with `edit_posts` can therefore request many distinct collection rooms and
  distribute load across per-room limits. Before public deployment, bound
  credential issuance and room cardinality with rate limiting, a
  registered-entity policy, or both. Local development deliberately preserves
  Core/VIP-style custom collection extensibility.

The [production runbook](docs/production-runbook.md) records the rollout,
rotation, log-redaction, rollback, and remaining release blockers. In
particular, the project still needs an explicit license, representative load
tests, and account-level edge abuse and credential-header controls.
