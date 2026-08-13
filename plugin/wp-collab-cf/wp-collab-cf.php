<?php
/**
 * Plugin Name: WP Collab Cloudflare
 * Description: Routes WordPress 7.0 real-time collaboration through a Cloudflare Workers relay instead of HTTP polling.
 * Version: 0.3.0
 */

defined( 'ABSPATH' ) || exit;

define( 'WP_COLLAB_CF_VERSION', '0.3.0' );

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
add_filter( 'filter_block_editor_meta_boxes', 'wp_collab_cf_capture_meta_box_diagnostics', PHP_INT_MAX );
add_action( 'admin_footer-post.php', 'wp_collab_cf_print_diagnostics_data', 99 );
add_action( 'admin_footer-post-new.php', 'wp_collab_cf_print_diagnostics_data', 99 );

/**
 * Describe a source file without exposing an absolute server path.
 *
 * @param string|false $file Callback source file.
 * @return array Sanitized source owner.
 */
function wp_collab_cf_source_owner_for_file( $file ) {
	$unknown = array(
		'ownerType'  => 'unknown',
		'owner'      => null,
		'sourceFile' => null,
	);
	if ( ! is_string( $file ) || '' === $file ) {
		return $unknown;
	}

	$path = wp_normalize_path( $file );
	$roots = array(
		'mu-plugin' => defined( 'WPMU_PLUGIN_DIR' ) ? wp_normalize_path( WPMU_PLUGIN_DIR ) : '',
		'plugin'    => defined( 'WP_PLUGIN_DIR' ) ? wp_normalize_path( WP_PLUGIN_DIR ) : '',
	);
	foreach ( $roots as $owner_type => $root ) {
		$prefix = rtrim( $root, '/' ) . '/';
		if ( '/' === $prefix || 0 !== strpos( $path, $prefix ) ) {
			continue;
		}
		$relative = substr( $path, strlen( $prefix ) );
		$segments = explode( '/', $relative );
		return array(
			'ownerType'  => $owner_type,
			'owner'      => $segments[0],
			'sourceFile' => $relative,
		);
	}

	if ( function_exists( 'get_theme_root' ) ) {
		$theme_root = rtrim( wp_normalize_path( get_theme_root() ), '/' ) . '/';
		if ( '/' !== $theme_root && 0 === strpos( $path, $theme_root ) ) {
			$relative = substr( $path, strlen( $theme_root ) );
			$segments = explode( '/', $relative );
			return array(
				'ownerType'  => 'theme',
				'owner'      => $segments[0],
				'sourceFile' => $relative,
			);
		}
	}

	$core_root = rtrim( wp_normalize_path( ABSPATH ), '/' ) . '/';
	if ( 0 === strpos( $path, $core_root ) ) {
		$relative = substr( $path, strlen( $core_root ) );
		if ( 0 === strpos( $relative, 'wp-admin/' ) || 0 === strpos( $relative, 'wp-includes/' ) ) {
			return array(
				'ownerType'  => 'wordpress-core',
				'owner'      => 'wordpress-core',
				'sourceFile' => $relative,
			);
		}
	}

	return $unknown;
}

/**
 * Return a callback class label without PHP's anonymous-class source path.
 *
 * @param object|string $callback_class Callback object or class name.
 * @return string Sanitized callback class label.
 */
function wp_collab_cf_callback_class_label( $callback_class ) {
	$class = is_object( $callback_class ) ? get_class( $callback_class ) : (string) $callback_class;
	if ( is_object( $callback_class ) ) {
		try {
			$reflection = new ReflectionClass( $callback_class );
			if ( $reflection->isAnonymous() ) {
				return 'anonymous-class';
			}
		} catch ( Throwable $error ) {
			// Fall through to the NUL-delimited anonymous name check.
		}
	}

	// Anonymous class names include a NUL-delimited source path in PHP.
	return false !== strpos( $class, "\0" ) ? 'anonymous-class' : $class;
}

/**
 * Identify a meta box callback and its likely owner.
 *
 * @param mixed $callback Meta box callback.
 * @return array Sanitized callback description.
 */
function wp_collab_cf_describe_callback( $callback ) {
	$label      = null;
	$reflection = null;
	try {
		if ( is_string( $callback ) && function_exists( $callback ) ) {
			$label      = $callback;
			$reflection = new ReflectionFunction( $callback );
		} elseif ( is_array( $callback ) && 2 === count( $callback ) ) {
			$class      = wp_collab_cf_callback_class_label( $callback[0] );
			$label      = $class . '::' . (string) $callback[1];
			$reflection = new ReflectionMethod( $callback[0], $callback[1] );
		} elseif ( $callback instanceof Closure ) {
			$label      = 'Closure';
			$reflection = new ReflectionFunction( $callback );
		} elseif ( is_object( $callback ) && is_callable( $callback ) ) {
			$label      = wp_collab_cf_callback_class_label( $callback ) . '::__invoke';
			$reflection = new ReflectionMethod( $callback, '__invoke' );
		}
	} catch ( Throwable $error ) {
		$reflection = null;
	}

	$source = wp_collab_cf_source_owner_for_file( $reflection ? $reflection->getFileName() : false );
	$source['callback'] = $label;
	return $source;
}

/**
 * Convert registered meta boxes to a browser-safe diagnostics list.
 *
 * @param array  $wp_meta_boxes Global meta box state.
 * @param string $screen_id     Current editor screen identifier.
 * @param bool   $include_owner Whether callback ownership may be disclosed.
 * @return array Sanitized meta box descriptions.
 */
function wp_collab_cf_describe_meta_boxes( $wp_meta_boxes, $screen_id, $include_owner ) {
	$descriptions = array();
	if ( ! isset( $wp_meta_boxes[ $screen_id ] ) || ! is_array( $wp_meta_boxes[ $screen_id ] ) ) {
		return $descriptions;
	}

	foreach ( $wp_meta_boxes[ $screen_id ] as $location => $priorities ) {
		foreach ( (array) $priorities as $priority => $boxes ) {
			foreach ( (array) $boxes as $meta_box ) {
				if (
					! is_array( $meta_box ) ||
					empty( $meta_box['title'] ) ||
					! empty( $meta_box['args']['__back_compat_meta_box'] )
				) {
					continue;
				}
				$source = $include_owner
					? wp_collab_cf_describe_callback( isset( $meta_box['callback'] ) ? $meta_box['callback'] : null )
					: array(
						'ownerType' => null,
						'owner'     => null,
						'sourceFile' => null,
						'callback'  => null,
					);
				$descriptions[] = array_merge(
					array(
						'id'            => isset( $meta_box['id'] ) ? (string) $meta_box['id'] : '',
						'title'         => wp_strip_all_tags( (string) $meta_box['title'] ),
						'location'      => (string) $location,
						'priority'      => (string) $priority,
						'rtcCompatible' => ! empty( $meta_box['args']['__rtc_compatible_meta_box'] ),
					),
					$source
				);
			}
		}
	}

	return $descriptions;
}

/**
 * Capture the final meta box compatibility state without changing it.
 *
 * @param array $wp_meta_boxes Global meta box state.
 * @return array Unmodified meta box state.
 */
function wp_collab_cf_capture_meta_box_diagnostics( $wp_meta_boxes ) {
	global $current_screen, $wp_collab_cf_diagnostics_meta_boxes;

	if ( $current_screen && isset( $current_screen->id ) ) {
		$wp_collab_cf_diagnostics_meta_boxes = wp_collab_cf_describe_meta_boxes(
			$wp_meta_boxes,
			$current_screen->id,
			current_user_can( 'activate_plugins' )
		);
	}

	return $wp_meta_boxes;
}

/**
 * Print sanitized diagnostics after WordPress and plugins register meta boxes.
 */
function wp_collab_cf_print_diagnostics_data() {
	global $post, $wp_collab_cf_diagnostics_meta_boxes, $wp_version;

	if ( ! wp_script_is( 'wp-collab-cf', 'enqueued' ) && ! wp_script_is( 'wp-collab-cf', 'done' ) ) {
		return;
	}

	$post_type = $post instanceof WP_Post ? $post->post_type : null;
	$report    = array(
		'wordpressVersion'     => isset( $wp_version ) ? (string) $wp_version : null,
		'gutenbergVersion'     => defined( 'GUTENBERG_VERSION' ) ? (string) GUTENBERG_VERSION : null,
		'pluginVersion'        => WP_COLLAB_CF_VERSION,
		'collaborationAllowed' => function_exists( 'wp_is_collaboration_allowed' ) ? wp_is_collaboration_allowed() : null,
		'collaborationEnabled' => function_exists( 'wp_is_collaboration_enabled' ) ? wp_is_collaboration_enabled() : null,
		'cloudflareConfigured' => wp_collab_cf_is_configured(),
		'postTypeDisabled'     => $post_type && function_exists( 'wp_is_post_type_collaboration_disabled' )
			? wp_is_post_type_collaboration_disabled( $post_type )
			: null,
		'metaBoxes'            => isset( $wp_collab_cf_diagnostics_meta_boxes ) && is_array( $wp_collab_cf_diagnostics_meta_boxes )
			? $wp_collab_cf_diagnostics_meta_boxes
			: array(),
	);
	$script    = 'window.wpCollabCfDiagnosticsServer = ' . wp_json_encode(
		$report,
		JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_SLASHES
	) . ';window.dispatchEvent(new Event("wp-collab-cf-diagnostics-ready"));';

	wp_print_inline_script_tag( $script );
}

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

	$configured = wp_collab_cf_is_configured();
	wp_localize_script(
		'wp-collab-cf',
		'wpCollabCf',
		array(
			'wsUrl'    => $configured ? WP_COLLAB_CF_WS_URL : '',
			'tokenUrl' => $configured ? rest_url( 'wp-collab-cf/v1/token' ) : '',
		)
	);
}
