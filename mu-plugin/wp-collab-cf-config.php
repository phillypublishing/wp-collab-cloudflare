<?php
/**
 * WP Collab Cloudflare Configuration
 *
 * Drop this file into wp-content/mu-plugins/ to enable WordPress 7.0
 * real-time collaboration via a Cloudflare Workers relay.
 *
 * Replace all placeholders. The site ID is a stable random identifier, and
 * the signing secret must also be configured in the Worker's
 * COLLAB_AUTH_KEYS secret. Never expose the signing secret to browser code.
 */

// Enable real-time collaboration.
if ( ! defined( 'WP_ALLOW_COLLABORATION' ) ) {
	define( 'WP_ALLOW_COLLABORATION', true );
}

// Point the sync provider at your Cloudflare Worker.
if ( ! defined( 'WP_COLLAB_CF_WS_URL' ) ) {
	define( 'WP_COLLAB_CF_WS_URL', 'wss://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev' );
}

if ( ! defined( 'WP_COLLAB_CF_SITE_ID' ) ) {
	define( 'WP_COLLAB_CF_SITE_ID', 'REPLACE_WITH_A_STABLE_RANDOM_SITE_ID' );
}

if ( ! defined( 'WP_COLLAB_CF_AUTH_SECRET' ) ) {
	define( 'WP_COLLAB_CF_AUTH_SECRET', 'REPLACE_WITH_A_RANDOM_32_PLUS_CHARACTER_SECRET' );
}

// Optional. Set this when COLLAB_AUTH_KEYS uses a named key for this site.
// Keep the old key in the Worker keyring until every old credential expires.
// if ( ! defined( 'WP_COLLAB_CF_AUTH_KEY_ID' ) ) {
// 	define( 'WP_COLLAB_CF_AUTH_KEY_ID', '2026-08' );
// }
