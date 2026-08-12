# WP Collab Cloudflare

Proof-of-concept that offloads WordPress 7.0's real-time collaboration (RTC) to a Cloudflare Workers relay, replacing the default HTTP polling transport with WebSockets over Durable Objects.

## Why

WordPress 7.0 introduces collaborative editing powered by Yjs. By default it syncs via HTTP polling (every 1-4 seconds). This works, but each poll holds a PHP worker for the duration of the request. On hosts with limited concurrency, no WebSocket support, or stateless containers, this becomes a bottleneck.

This project moves the sync relay to Cloudflare's edge:

- **Durable Objects** coordinate live document state with single-threaded consistency
- **WebSocket Hibernation** means idle editing sessions cost nothing
- **PHP workers** are freed from long-polling — they only handle normal page/API requests

## Architecture

```
Browser A ──WebSocket──┐
                        ├── Cloudflare Durable Object (ephemeral Yjs relay)
Browser B ──WebSocket──┘
```

Four pieces work together:

| Component | Path | Purpose |
|-----------|------|---------|
| **Worker** | [`worker/`](worker/) | Cloudflare Worker + Durable Object running [y-partyserver](https://github.com/cloudflare/partykit/tree/main/packages/y-partyserver) as a Yjs sync relay |
| **Plugin** | [`plugin/wp-collab-cf/`](plugin/wp-collab-cf/) | WordPress plugin that hooks into the `sync.providers` filter to swap HTTP polling for a WebSocket connection to the Worker |
| **MU-Plugin** | [`mu-plugin/`](mu-plugin/) | Enables `WP_ALLOW_COLLABORATION` and sets the `WP_COLLAB_CF_WS_URL` constant that the plugin reads |
| **Demo Plugin** | [`plugin/wp-collab-cf-demo/`](plugin/wp-collab-cf-demo/) | Optional. Magic link that creates temporary guest users restricted to a single demo post, useful for sharing a live demo |

## Setup

### 1. Create the shared credentials

Generate one stable site ID and one random signing secret. The site ID is a
namespace; the secret must remain server-side.

```bash
openssl rand -hex 16 # use as the site ID
openssl rand -hex 32 # use as the signing secret
```

The same values are configured in WordPress below. Configure the Worker's
secret as a JSON object so one Worker can recognize distinct site keys. The
legacy single-key format remains supported:

```json
{"YOUR_SITE_ID":"YOUR_SIGNING_SECRET"}
```

New installations should use a named key so later rotations can overlap:

```json
{"YOUR_SITE_ID":{"keys":{"2026-08":"YOUR_SIGNING_SECRET"}}}
```

### 2. Deploy the Worker

```bash
cd worker
npm install
# Authenticate with Cloudflare (or set CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN)
wrangler login
wrangler secret put COLLAB_AUTH_KEYS --env staging
npm run check
npm run deploy:staging
```

Promote the same verified commit with `npm run deploy:production` only after
the staging checks in [the production runbook](docs/production-runbook.md).
Note the deployed URL (for example,
`wss://wp-collab-cloudflare-staging.your-subdomain.workers.dev`).

### 3. Configure WordPress

Copy the [mu-plugin](mu-plugin/wp-collab-cf-config.php) to `wp-content/mu-plugins/` and set your Worker URL:

```php
define( 'WP_COLLAB_CF_WS_URL', 'wss://wp-collab-cloudflare.your-subdomain.workers.dev' );
define( 'WP_COLLAB_CF_SITE_ID', 'YOUR_SITE_ID' );
define( 'WP_COLLAB_CF_AUTH_SECRET', 'YOUR_SIGNING_SECRET' );
define( 'WP_COLLAB_CF_AUTH_KEY_ID', '2026-08' ); // For named keys only.
```

### 4. Install the Plugin

```bash
cd plugin/wp-collab-cf
npm install
npm run build
```

Copy the `plugin/wp-collab-cf/` directory (with the `build/` output) into `wp-content/plugins/` and activate it.

### 5. Test

Open the same post in two browser tabs. Edits in one tab should appear in the other in real time.

## Demo Plugin (Optional)

The [demo plugin](plugin/wp-collab-cf-demo/) provides a magic link for sharing a live demo publicly (e.g. on social media). When someone visits the link:

1. A temporary guest user is created automatically (e.g. "Guest A3X9B2")
2. They're logged in and redirected straight to the post editor
3. All admin UI is hidden — they only see the block editor
4. They can only edit the designated demo post, nothing else

### Setup

1. Copy `plugin/wp-collab-cf-demo/` into `wp-content/plugins/` and activate it.
2. Create a post to use as the demo and note its ID.
3. Set the post ID via WP-CLI or in wp-config:

```php
define( 'WP_COLLAB_CF_DEMO_POST_ID', 123 );
```

Or via option: `wp option update wp_collab_cf_demo_post_id 123`

4. Share the magic link: `https://yoursite.com/?wp-collab-demo=1`

## How It Works

1. The **mu-plugin** defines `WP_ALLOW_COLLABORATION` (enabling RTC) and `WP_COLLAB_CF_WS_URL` (the relay endpoint).

2. The **plugin** uses the [`sync.providers`](https://developer.wordpress.org/reference/hooks/sync-providers/) filter to replace WordPress's default HTTP polling provider with a WebSocket provider. Before connecting, it requests a short-lived credential through Core `wp.apiFetch`, including its supported cookie/nonce refresh behavior. WordPress verifies `edit_post` for a post. Collection requests keep Gutenberg's native `objectId: null`, require the HTTP sync server's minimum `edit_posts` capability, and use `WP_Sync_Config` plus the `wp_collab_cf_collection_sync_permission` extension filter. The provider uses `y-partyserver` and reuses WordPress's bundled Yjs instance (via `wp.sync.Y`) to avoid duplicate library issues.

3. The **Worker** receives that credential in a WebSocket subprotocol rather than the URL, verifies it plus the exact editor Origin, site/blog namespace, and room, strips the credential header, then routes to [y-partyserver](https://github.com/cloudflare/partykit/tree/main/packages/y-partyserver). Each authorized room gets its own Durable Object instance. A Durable Object alarm ends each connection at credential expiry so reconnection reauthorizes against WordPress.

4. The Durable Object keeps Yjs state in memory only. Gutenberg persists its
   CRDT snapshot in WordPress post meta, and connected clients re-sync the room
   after hibernation. A fully disconnected Worker restart starts with an empty
   relay and Gutenberg hydrates the client from WordPress. See
   [SECURITY.md](SECURITY.md) for the persistence boundary and residual risks.
   This matches the relay/persistence split in Automattic's
   [VIP RTC reference](https://github.com/Automattic/vip-real-time-collaboration).

Collection rooms carry Gutenberg's lightweight save/invalidation Yjs state,
not the REST records themselves. WordPress converts the null object ID to the
internal `collection` room sentinel only after authorization. Bounded
`kind/name` collection shapes can reach the permission filter so custom
Gutenberg entities are extensible; unknown kinds are denied by default.
Non-collection support remains restricted to positive-ID post entities.

The Worker also applies fail-closed per-room connection, frame, Yjs update,
in-memory merged-document, and per-connection rate limits. Checked-in defaults and
environment-specific deployment procedures are documented in the
[production runbook](docs/production-runbook.md).
