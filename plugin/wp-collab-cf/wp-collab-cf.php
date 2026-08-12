<?php
/**
 * Plugin Name: WP Collab Cloudflare
 * Description: Routes WordPress 7.0 real-time collaboration through a Cloudflare Workers relay instead of HTTP polling.
 * Version: 0.2.0
 */

defined( 'ABSPATH' ) || exit;

/**
 * Set your deployed Worker URL, site identifier, and signing secret in
 * wp-config.php or an mu-plugin. Keep the signing secret server-side:
 *
 *   define( 'WP_COLLAB_CF_WS_URL', 'wss://wp-collab-cloudflare.YOUR-SUBDOMAIN.workers.dev' );
 *   define( 'WP_COLLAB_CF_SITE_ID', 'YOUR_STABLE_SITE_ID' );
 *   define( 'WP_COLLAB_CF_AUTH_SECRET', 'YOUR_RANDOM_32_PLUS_CHARACTER_SECRET' );
 *   define( 'WP_COLLAB_CF_AUTH_KEY_ID', '2026-08' ); // Optional during keyed rotation.
 */

add_action( 'admin_enqueue_scripts', 'wp_collab_cf_enqueue_scripts' );
add_action( 'rest_api_init', 'wp_collab_cf_register_rest_routes' );

/**
 * Return whether all secure collaboration settings are present and valid.
 *
 * @return bool
 */
function wp_collab_cf_is_configured() {
	$worker_scheme = defined( 'WP_COLLAB_CF_WS_URL' ) && is_string( WP_COLLAB_CF_WS_URL )
		? wp_parse_url( WP_COLLAB_CF_WS_URL, PHP_URL_SCHEME )
		: false;

	$key_id_valid = ! defined( 'WP_COLLAB_CF_AUTH_KEY_ID' )
		|| (
			is_string( WP_COLLAB_CF_AUTH_KEY_ID )
			&& preg_match( '/^[A-Za-z0-9_-]{1,32}$/', WP_COLLAB_CF_AUTH_KEY_ID )
		);

	return defined( 'WP_COLLAB_CF_WS_URL' )
		&& defined( 'WP_COLLAB_CF_SITE_ID' )
		&& defined( 'WP_COLLAB_CF_AUTH_SECRET' )
		&& is_string( WP_COLLAB_CF_WS_URL )
		&& is_string( WP_COLLAB_CF_SITE_ID )
		&& is_string( WP_COLLAB_CF_AUTH_SECRET )
		&& in_array( $worker_scheme, array( 'ws', 'wss' ), true )
		&& preg_match( '/^[A-Za-z0-9_-]{16,64}$/', WP_COLLAB_CF_SITE_ID )
		&& preg_match( '/^[A-Za-z0-9_-]{32,128}$/', WP_COLLAB_CF_AUTH_SECRET )
		&& $key_id_valid;
}

/**
 * Encode bytes using unpadded base64url.
 *
 * @param string $value Raw value.
 * @return string
 */
function wp_collab_cf_base64url_encode( $value ) {
	return rtrim( strtr( base64_encode( $value ), '+/', '-_' ), '=' );
}

/**
 * Return the browser Origin associated with the WordPress admin.
 *
 * @return string|WP_Error
 */
function wp_collab_cf_site_origin() {
	$parts = wp_parse_url( admin_url( '/' ) );
	if ( ! is_array( $parts ) || empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
		return new WP_Error( 'wp_collab_cf_invalid_origin', 'The WordPress admin URL does not have a valid origin.' );
	}

	$scheme = strtolower( $parts['scheme'] );
	if ( 'http' !== $scheme && 'https' !== $scheme ) {
		return new WP_Error( 'wp_collab_cf_invalid_origin', 'The WordPress admin URL must use HTTP or HTTPS.' );
	}

	$origin = $scheme . '://' . strtolower( $parts['host'] );
	if (
		! empty( $parts['port'] ) &&
		! ( 'http' === $scheme && 80 === (int) $parts['port'] ) &&
		! ( 'https' === $scheme && 443 === (int) $parts['port'] )
	) {
		$origin .= ':' . (int) $parts['port'];
	}

	return $origin;
}

/**
 * Validate a collaboration object and return its namespaced room identifier.
 *
 * Collections use Gutenberg's null object identifier at the provider and REST
 * boundaries. The literal "collection" sentinel is internal room-shape data;
 * clients cannot use it to bypass single-entity validation.
 *
 * @param string $object_type Sync object type, for example postType/post.
 * @param mixed  $object_id   Sync object identifier.
 * @return string|WP_Error
 */
function wp_collab_cf_room_for_object( $object_type, $object_id ) {
	if ( ! is_string( $object_type ) || strlen( $object_type ) > 128 ) {
		return new WP_Error( 'wp_collab_cf_invalid_object', 'This collaboration object is not supported.', array( 'status' => 400 ) );
	}

	if ( ! preg_match( '/^([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/', $object_type, $matches ) ) {
		return new WP_Error( 'wp_collab_cf_invalid_object', 'This collaboration object is not supported.', array( 'status' => 400 ) );
	}

	$entity_kind = $matches[1];
	$entity_name = $matches[2];
	if ( null === $object_id ) {
		if (
			! current_user_can( 'edit_posts' ) ||
			! is_callable( array( 'WP_Sync_Config', 'can_user_sync_entity_type' ) )
		) {
			return new WP_Error( 'wp_collab_cf_forbidden_object', 'You cannot collaborate on this object.', array( 'status' => 403 ) );
		}

		$can_sync = WP_Sync_Config::can_user_sync_entity_type( $entity_kind, $entity_name, null );
		/**
		 * Filters whether the current user may receive a collection-room credential.
		 *
		 * Authentication and the Gutenberg HTTP sync server's minimum `edit_posts`
		 * capability are enforced before this filter. The initial value comes from
		 * Gutenberg's WP_Sync_Config permission model.
		 *
		 * @param bool   $can_sync    Whether Gutenberg permits the collection.
		 * @param string $entity_kind Gutenberg entity kind.
		 * @param string $entity_name Gutenberg entity name.
		 * @param null   $object_id   Null for collection rooms.
		 */
		$can_sync = (bool) apply_filters(
			'wp_collab_cf_collection_sync_permission',
			$can_sync,
			$entity_kind,
			$entity_name,
			null
		);
		if ( ! $can_sync ) {
			return new WP_Error( 'wp_collab_cf_forbidden_object', 'You cannot collaborate on this object.', array( 'status' => 403 ) );
		}

		$room_object_id = 'collection';
	} else {
		if ( 'postType' !== $entity_kind ) {
			return new WP_Error( 'wp_collab_cf_invalid_object', 'This collaboration object is not supported.', array( 'status' => 400 ) );
		}

		if ( ! is_numeric( $object_id ) || (string) (int) $object_id !== (string) $object_id || (int) $object_id < 1 ) {
			return new WP_Error( 'wp_collab_cf_invalid_object', 'This collaboration object is not supported.', array( 'status' => 400 ) );
		}

		$post = get_post( (int) $object_id );
		if ( ! $post || $post->post_type !== $entity_name || ! current_user_can( 'edit_post', $post->ID ) ) {
			return new WP_Error( 'wp_collab_cf_forbidden_object', 'You cannot collaborate on this object.', array( 'status' => 403 ) );
		}
		$room_object_id = (string) $post->ID;
	}

	return implode(
		'.',
		array(
			'v1',
			WP_COLLAB_CF_SITE_ID,
			(string) get_current_blog_id(),
			wp_collab_cf_base64url_encode( $object_type ),
			wp_collab_cf_base64url_encode( $room_object_id ),
		)
	);
}

/**
 * Issue a signed, short-lived, room-scoped WebSocket credential.
 *
 * @param string $object_type Sync object type.
 * @param mixed  $object_id   Sync object identifier.
 * @return array|WP_Error
 */
function wp_collab_cf_issue_credentials( $object_type, $object_id ) {
	if ( ! wp_collab_cf_is_configured() ) {
		return new WP_Error( 'wp_collab_cf_not_configured', 'Secure collaboration is not configured.', array( 'status' => 503 ) );
	}

	$user_id = get_current_user_id();
	if ( ! $user_id ) {
		return new WP_Error( 'wp_collab_cf_not_authenticated', 'Authentication is required.', array( 'status' => 401 ) );
	}

	$room = wp_collab_cf_room_for_object( $object_type, $object_id );
	if ( is_wp_error( $room ) ) {
		return $room;
	}

	$origin = wp_collab_cf_site_origin();
	if ( is_wp_error( $origin ) ) {
		return $origin;
	}

	$issued_at = time();
	$ttl       = (int) apply_filters( 'wp_collab_cf_token_ttl', 60 );
	$ttl       = max( 30, min( 300, $ttl ) );
	$claims    = array(
		'v'      => 1,
		'aud'    => 'wp-collab-cloudflare',
		'site'   => WP_COLLAB_CF_SITE_ID,
		'blog'   => (string) get_current_blog_id(),
		'origin' => $origin,
		'room'   => $room,
		'sub'    => (string) $user_id,
		'iat'    => $issued_at,
		'nbf'    => $issued_at - 5,
		'exp'    => $issued_at + $ttl,
	);
	if ( defined( 'WP_COLLAB_CF_AUTH_KEY_ID' ) ) {
		$claims['kid'] = WP_COLLAB_CF_AUTH_KEY_ID;
	}
	$json      = wp_json_encode( $claims, JSON_UNESCAPED_SLASHES );
	if ( false === $json ) {
		return new WP_Error( 'wp_collab_cf_token_error', 'The collaboration credential could not be created.', array( 'status' => 500 ) );
	}

	$payload   = wp_collab_cf_base64url_encode( $json );
	$signature = wp_collab_cf_base64url_encode( hash_hmac( 'sha256', $payload, WP_COLLAB_CF_AUTH_SECRET, true ) );

	return array(
		'room'      => $room,
		'token'     => $payload . '.' . $signature,
		'expiresAt' => $issued_at + $ttl,
	);
}

/**
 * Register the authenticated credential endpoint used by the editor provider.
 */
function wp_collab_cf_register_rest_routes() {
	register_rest_route(
		'wp-collab-cf/v1',
		'/token',
		array(
			'methods'             => WP_REST_Server::CREATABLE,
			'callback'            => 'wp_collab_cf_rest_issue_credentials',
			'permission_callback' => function () {
				return is_user_logged_in();
			},
			'args'                => array(
				'objectType' => array(
					'required' => true,
					'type'     => 'string',
				),
				'objectId'   => array(
					'type'     => array( 'integer', 'null' ),
					'minimum'  => 1,
				),
			),
		)
	);
}

/**
 * REST callback for secure collaboration credentials.
 *
 * Cookie authentication and X-WP-Nonce validation are performed by WordPress
 * before this callback. Object-level authorization is performed while issuing
 * the room credential.
 *
 * @param WP_REST_Request $request Request object.
 * @return WP_REST_Response|WP_Error
 */
function wp_collab_cf_rest_issue_credentials( WP_REST_Request $request ) {
	$json_params = $request->get_json_params();
	if (
		null === $request->get_param( 'objectId' ) &&
		( ! is_array( $json_params ) || ! array_key_exists( 'objectId', $json_params ) )
	) {
		return new WP_Error( 'wp_collab_cf_invalid_object', 'This collaboration object is not supported.', array( 'status' => 400 ) );
	}

	$credentials = wp_collab_cf_issue_credentials(
		$request->get_param( 'objectType' ),
		$request->get_param( 'objectId' )
	);
	if ( is_wp_error( $credentials ) ) {
		return $credentials;
	}

	$response = rest_ensure_response( $credentials );
	$response->header( 'Cache-Control', 'no-store' );
	return $response;
}

function wp_collab_cf_enqueue_scripts( $hook ) {
	if ( ! wp_collab_cf_is_configured() ) {
		return;
	}

	// Only load on the post editor screen.
	if ( 'post.php' !== $hook && 'post-new.php' !== $hook ) {
		return;
	}

	$asset_file = __DIR__ . '/build/index.asset.php';
	if ( ! file_exists( $asset_file ) ) {
		return;
	}

	$asset = require $asset_file;

	wp_enqueue_script(
		'wp-collab-cf',
		plugin_dir_url( __FILE__ ) . 'build/index.js',
		array_merge(
			$asset['dependencies'],
			array( 'wp-data', 'wp-notices', 'wp-sync' )
		),
		$asset['version'],
		array( 'in_footer' => false )
	);

	wp_localize_script( 'wp-collab-cf', 'wpCollabCf', array(
		'wsUrl'    => WP_COLLAB_CF_WS_URL,
		'tokenUrl' => rest_url( 'wp-collab-cf/v1/token' ),
	) );
}
