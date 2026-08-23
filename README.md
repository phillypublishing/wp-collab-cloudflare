# WP Collab Cloudflare

Proof-of-concept that offloads Gutenberg's experimental real-time collaboration (RTC) to a Cloudflare Workers relay, replacing the default HTTP polling transport with WebSockets over Durable Objects.

## Why

Gutenberg's Real-Time Collaboration experiment uses Yjs and syncs via HTTP polling by default (every 1-4 seconds). This works, but each poll holds a PHP worker for the duration of the request. On hosts with limited concurrency, no WebSocket support, or stateless containers, this becomes a bottleneck.

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
| **MU-Plugin** | [`mu-plugin/`](mu-plugin/) | Supplies the authenticated Worker URL, site ID, and signing-key configuration that the plugin reads |
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

The top-level Wrangler configuration is for local development only and rejects
deployment. Always deploy one of the named environments through the package
scripts above.

Bootstrap production once with `npm run deploy:production`, then configure its
independent `COLLAB_AUTH_KEYS` secret. Future production releases use the
manual **Production Worker deploy** GitHub Actions workflow with the full
40-character commit SHA already merged to `main`. Production never deploys on
an ordinary `main` push or from a mutable `stable`/`production` branch. The
workflow revalidates the exact revision, requires the existing Cloudflare
keyring, deploys only the named production environment, and checks its stable
health URL. See [the production runbook](docs/production-runbook.md).

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

In Gutenberg 23.8 or newer, enable **Real-Time Collaboration** under
**Settings > Gutenberg > Experiments**. The experiment is the source of truth;
the former `WP_ALLOW_COLLABORATION` and `wp_collaboration_enabled` settings no
longer enable RTC.

### 4. Install the Plugin

Every pushed ref state that changes the plugin builds a 30-day GitHub Actions
artifact named `wp-collab-cf-<commit>`. It contains the installable ZIP, its
SHA-256 checksum, and a provenance manifest. Download the artifact for the exact
plugin source commit you want to test, verify the checksum, and upload the ZIP
through **Plugins > Add Plugin > Upload Plugin**. The ZIP contains only the
runtime PHP file and compiled JavaScript assets; source and Node dependencies
are deliberately excluded.

To reproduce the allowlisted artifact locally from a clean checkout with the
same packaging toolchain:

```bash
cd wp-collab-cloudflare
npm --prefix plugin/wp-collab-cf ci
./scripts/build-plugin-artifact.sh
(cd dist && sha256sum --check wp-collab-cf-*.zip.sha256)
```

Merging a changed plugin `Version:` header to `main` publishes the same
allowlisted assets as a GitHub Release tagged `wp-collab-cf-v<version>`. A
matching draft is safely resumed after an interrupted upload; conflicting tags,
releases, or assets are refused. The header, runtime constant, package version,
manifest, ZIP, and checksum must all agree before the draft is published. A
retry keeps already-verified assets and uploads only missing files to the
verified release ID. Plugin tests, the production dependency audit, PHP lint,
and PHP diagnostics also pass before publication.

For editable development instead:

```bash
cd plugin/wp-collab-cf
npm ci
npm run build
```

Copy the `plugin/wp-collab-cf/` directory (with the `build/` output) into `wp-content/plugins/` and activate it.

### Diagnose collaboration compatibility

The plugin exposes a read-only `wpCollabCfDiagnostics` object in the browser
console on post editor screens. When Gutenberg disables collaboration because
of configuration, post-type sync support, or an incompatible legacy meta box,
the plugin automatically prints a sanitized report. To print a fresh report:

```js
wpCollabCfDiagnostics.log();
```

The meta box table includes the ID, title, compatibility flag, and—when the
current user can activate plugins—the likely owning plugin, must-use plugin,
theme, or WordPress Core source. The report never includes the site signing
secret, site identifier, room credential, WebSocket subprotocol, or absolute
server paths. Diagnostics do not mark a meta box as compatible; plugin authors
must opt in with `__rtc_compatible_meta_box` only after verifying that its data
model is safe during concurrent editing.

### Suppress selected meta boxes site-wide

Sites may explicitly remove selected legacy meta boxes from block-editor
requests without changing their registration, callbacks, or save hooks. The
plugin does not directly change saved meta, but an owning plugin's save handler
may react to missing form fields. Characterize every selected meta box against
the exact plugin version before rollout. Supply exact IDs with the
`wp_collab_cf_suppressed_meta_box_ids` filter;
there are no built-in third-party defaults, wildcards, or fuzzy matching:

```php
add_filter(
	'wp_collab_cf_suppressed_meta_box_ids',
	function ( $ids, WP_Screen $screen, WP_Post $post ) {
		if ( 'post' === $screen->id ) {
			$ids[] = 'your_exact_meta_box_id';
		}
		return $ids;
	},
	10,
	3
);
```

Two configured IDs use minimum-version compatibility adapters instead of the
generic late registry removal:

- `mepr_unauthorized_message` is removed for MemberPress Scale 1.12.17 or newer
  when every active occurrence still uses the exact
  `MeprAppCtrl::unauthorized_meta_box` callback. A version or callback mismatch
  leaves the complete box present so Gutenberg keeps exclusive editing.
- `wpseo_meta` is supported for Yoast SEO Core 28.2 + Premium 28.2 or newer,
  optionally with Yoast SEO: News 13.3, Video 15.2, and Local 15.8 or newer.
  The adapter uses Yoast's post-type owner filter before meta-box registration,
  rejects other obvious active Yoast add-ons and protected Yoast block content
  (including uncertain synced-pattern graphs), and removes the exact
  characterized editor asset graph. This includes `wpseo-news-editor` and the
  Video metabox bundle when those add-ons are active. It never falls back to
  generic late removal. Core FAQ, How-to, breadcrumb, Premium dynamic-block,
  redirect, News sitemap/schema, Video sitemap/schema, Local blocks, frontend
  SEO/schema, indexable, and save integrations remain available.

These adapters are fail-closed below their minimum versions. Malformed or
missing versions, callback mismatches, unsupported add-ons,
asset dependencies, protected blocks, or uncertain synced content leave RTC
blocked after Yoast consults its owner filter. A remaining real box also keeps
Gutenberg exclusive; an absent box with an unobserved owner filter means Yoast
is inactive on that screen and does not add a synthetic blocker. Yoast Premium
prominent-word relationships may remain stale after a content-only
collaborative edit, and News stock-ticker/exclusion values remain frozen while
its editor UI is suppressed. Validate those known limitations before production
rollout. Video metabox controls are unavailable while its editor UI is
suppressed; content-derived Video SEO metadata may still be recomputed on save.
Local's independent block-editor blocks remain available. Disabling the
site-wide option and reloading restores the normal vendor UI.

The policy defaults to off. A user with `manage_options` can enable it from
**Settings → Real-time Collaboration**. Enabling it is site-wide for the current
WordPress blog: the selected boxes no longer render or submit for any user.
Every post editor shows the current policy as read-only status; administrators
also receive a link to the Settings page. Reload open editors after a change.
The existing cookie-authenticated REST endpoint remains available for controlled
automation. Disable the policy to restore normal rendering and Gutenberg's
compatibility blockade.

`wpCollabCfDiagnostics.report().metaBoxSuppression` reports the configured,
matched, suppressed, unmatched, and remaining blocker IDs plus enabled,
effective, and malformed-policy state. Remaining blockers and compatibility
still come exclusively from Gutenberg's rendered meta-box store.
`wpCollabCfDiagnostics.report().compatibilityAdapters` separately reports the
sanitized MemberPress and Yoast adapter eligibility, application, version
policy, supported minimums, owner-filter, protected-content, add-on, opaque
dependency-count, and asset-pruning states. The `adapter` values remain stable
diagnostics/v1 compatibility aliases; new consumers should use the generic
`policyId` together with `versionPolicy` and `minimumVersions`. Characterized
Yoast add-ons also report their sanitized active versions in `newsVersion`,
`videoVersion`, and `localVersion`.
It contains no post content, absolute paths, or proprietary plugin basenames.

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

1. Gutenberg's **Real-Time Collaboration** experiment enables RTC, and the
   **mu-plugin** supplies the authenticated Cloudflare relay configuration.

2. The **plugin** uses the [`sync.providers`](https://developer.wordpress.org/reference/hooks/sync-providers/) filter to replace WordPress's default HTTP polling provider with a WebSocket provider. Before connecting, it requests a short-lived credential through Core `wp.apiFetch`, including its supported cookie/nonce refresh behavior. WordPress verifies `edit_post` for a post. Collection requests keep Gutenberg's native `objectId: null`, require the HTTP sync server's minimum `edit_posts` capability, and use `WP_Sync_Config` plus the `wp_collab_cf_collection_sync_permission` extension filter. The provider uses `y-partyserver` and reuses WordPress's bundled Yjs instance (via `wp.sync.Y`) to avoid duplicate library issues.

3. The **Worker** receives that credential in a WebSocket subprotocol rather than the URL, verifies it plus the exact editor Origin, site/blog namespace, and room, strips the credential header, then routes to [y-partyserver](https://github.com/cloudflare/partykit/tree/main/packages/y-partyserver). Each authorized room gets its own Durable Object instance. The short-lived grant authenticates the upgrade; an independent four-hour Durable Object session timeout bounds established access without forcing presence to leave and rejoin every minute. This follows the session model in Automattic's VIP RTC reference.

4. The Durable Object keeps Yjs state in memory only. Gutenberg persists its
   CRDT snapshot in WordPress post meta, and connected clients re-sync the room
   after hibernation. Closing the final peer resets the in-memory Yjs document,
   so a later editor starts with an empty relay and Gutenberg hydrates it from
   WordPress. See
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
