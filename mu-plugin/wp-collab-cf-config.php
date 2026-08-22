<?php
/**
 * WP Collab Cloudflare Configuration
 *
 * Drop this file into wp-content/mu-plugins/ to route Gutenberg's Real-Time
 * Collaboration experiment through a Cloudflare Workers relay.
 *
 * Replace all placeholders. The site ID is a stable random identifier, and
 * the signing secret must also be configured in the Worker's
 * COLLAB_AUTH_KEYS secret. Never expose the signing secret to browser code.
 * Enable Real-Time Collaboration under Settings > Gutenberg > Experiments.
 */

// Point the sync provider at your Cloudflare Worker.
if ( ! defined( 'WP_COLLAB_CF_WS_URL' ) ) {
	define( 'WP_COLLAB_CF_WS_URL', 'wss://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev' );
}

if ( ! defined( 'WP_COLLAB_CF_SITE_ID' ) ) {
	define( 'WP_COLLAB_CF_SITE_ID', 'replace-me' );
}

if ( ! defined( 'WP_COLLAB_CF_AUTH_SECRET' ) ) {
	define( 'WP_COLLAB_CF_AUTH_SECRET', 'replace-me' );
}

// Optional. Set this when COLLAB_AUTH_KEYS uses a named key for this site.
// Keep the old key in the Worker keyring until every old grant expires. Live
// sessions no longer need the signing key after their upgrade is accepted.
// if ( ! defined( 'WP_COLLAB_CF_AUTH_KEY_ID' ) ) {
// 	define( 'WP_COLLAB_CF_AUTH_KEY_ID', '2026-08' );
// }
