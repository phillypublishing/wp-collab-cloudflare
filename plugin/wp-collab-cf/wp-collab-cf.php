<?php
/**
 * Plugin Name: WP Collab Cloudflare
 * Description: Routes WordPress 7.0 real-time collaboration through a Cloudflare Workers relay instead of HTTP polling.
 * Version: 0.5.4
 */

defined( 'ABSPATH' ) || exit;

define( 'WP_COLLAB_CF_VERSION', '0.5.4' );

require_once __DIR__ . '/includes/compatibility/version-policy.php';
require_once __DIR__ . '/includes/compatibility/memberpress.php';
require_once __DIR__ . '/includes/compatibility/yoast-seo.php';
require_once __DIR__ . '/includes/compatibility/meta-box-policy.php';

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
add_action( 'admin_menu', 'wp_collab_cf_register_settings_page' );
add_action( 'admin_post_wp_collab_cf_update_meta_box_suppression', 'wp_collab_cf_handle_meta_box_suppression_settings_update' );
add_action( 'rest_api_init', 'wp_collab_cf_register_rest_routes' );
add_filter( 'filter_block_editor_meta_boxes', 'wp_collab_cf_filter_block_editor_meta_boxes', 90 );
add_filter( 'filter_block_editor_meta_boxes', 'wp_collab_cf_capture_meta_box_diagnostics', PHP_INT_MAX );
add_action( 'admin_footer-post.php', 'wp_collab_cf_print_diagnostics_data', 99 );
add_action( 'admin_footer-post-new.php', 'wp_collab_cf_print_diagnostics_data', 99 );

/**
 * Return the configured site-wide meta box suppression policy.
 *
 * Any malformed filter result invalidates the complete policy. IDs are exact,
 * case-sensitive strings; no wildcard or fuzzy matching is performed.
 *
 * @return array Policy IDs and an optional diagnostic warning.
 */
function wp_collab_cf_get_suppressed_meta_box_ids() {
	global $current_screen, $post;

	$configured = apply_filters(
		'wp_collab_cf_suppressed_meta_box_ids',
		array(),
		$current_screen,
		$post
	);
	if ( ! is_array( $configured ) ) {
		return array(
			'ids'     => array(),
			'warning' => 'malformed_suppressed_meta_box_ids',
		);
	}

	$ids = array();
	foreach ( $configured as $id ) {
		if ( ! is_string( $id ) || '' === $id ) {
			return array(
				'ids'     => array(),
				'warning' => 'malformed_suppressed_meta_box_ids',
			);
		}
		if ( ! in_array( $id, $ids, true ) ) {
			$ids[] = $id;
		}
	}

	return array(
		'ids'     => $ids,
		'warning' => null,
	);
}

/**
 * Return whether the current blog has enabled its site-wide suppression policy.
 *
 * @return bool
 */
function wp_collab_cf_is_meta_box_suppression_enabled() {
	$enabled = get_option( 'wp_collab_cf_meta_box_suppression_enabled', false );
	return true === $enabled || 1 === $enabled || '1' === $enabled;
}

/**
 * Return the administrator-facing settings URL for the current site.
 *
 * @return string
 */
function wp_collab_cf_get_settings_page_url() {
	return admin_url( 'options-general.php?page=wp-collab-cf' );
}

/**
 * Register the site-wide collaboration settings screen.
 */
function wp_collab_cf_register_settings_page() {
	add_options_page(
		'Real-time Collaboration',
		'Real-time Collaboration',
		'manage_options',
		'wp-collab-cf',
		'wp_collab_cf_render_settings_page'
	);
}

/**
 * Render the site-wide legacy meta-box policy control.
 */
function wp_collab_cf_render_settings_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_die( 'You are not allowed to manage real-time collaboration settings.' );
	}

	$enabled = wp_collab_cf_is_meta_box_suppression_enabled();
	?>
	<div class="wrap">
		<h1>Real-time Collaboration</h1>
		<?php if ( isset( $_GET['settings-updated'] ) && '1' === $_GET['settings-updated'] ) : // phpcs:ignore WordPress.Security.NonceVerification.Recommended ?>
			<div class="notice notice-success is-dismissible"><p>Settings saved.</p></div>
		<?php endif; ?>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<input type="hidden" name="action" value="wp_collab_cf_update_meta_box_suppression">
			<?php wp_nonce_field( 'wp_collab_cf_update_meta_box_suppression' ); ?>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row">Legacy meta-box suppression</th>
					<td>
						<label>
							<input type="checkbox" name="enabled" value="1"<?php checked( $enabled ); ?>>
							Suppress configured legacy meta boxes site-wide
						</label>
						<p class="description">
							When enabled, configured meta boxes will not render or submit for anyone on this site. Reload any open editors after changing this setting.
						</p>
						<p class="description">
							This plugin does not directly change saved meta, but third-party save handlers may react to missing fields. Validate each compatibility adapter before rollout.
						</p>
					</td>
				</tr>
			</table>
			<?php submit_button(); ?>
		</form>
	</div>
	<?php
}

/**
 * Persist an exact site-wide policy boolean.
 *
 * @param bool $enabled Whether suppression is enabled.
 * @return bool|WP_Error Saved value or an error.
 */
function wp_collab_cf_update_meta_box_suppression_option( $enabled ) {
	if ( ! is_bool( $enabled ) ) {
		return new WP_Error(
			'wp_collab_cf_invalid_suppression_setting',
			'The enabled setting must be an exact boolean and cannot target a user or blog.',
			array( 'status' => 400 )
		);
	}

	$updated = update_option( 'wp_collab_cf_meta_box_suppression_enabled', $enabled );
	if ( ! $updated && wp_collab_cf_is_meta_box_suppression_enabled() !== $enabled ) {
		return new WP_Error(
			'wp_collab_cf_suppression_update_failed',
			'The site-wide meta box suppression policy could not be saved.',
			array( 'status' => 500 )
		);
	}

	return $enabled;
}

/**
 * Save the site-wide policy from Settings > Real-time Collaboration.
 */
function wp_collab_cf_handle_meta_box_suppression_settings_update() {
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_die( 'You are not allowed to manage real-time collaboration settings.', '', array( 'response' => 403 ) );
	}
	check_admin_referer( 'wp_collab_cf_update_meta_box_suppression' );

	$enabled = false;
	if ( isset( $_POST['enabled'] ) ) {
		$value = wp_unslash( $_POST['enabled'] );
		if ( ! is_string( $value ) || '1' !== $value ) {
			wp_die( 'The suppression setting was invalid.', '', array( 'response' => 400 ) );
		}
		$enabled = true;
	}

	$result = wp_collab_cf_update_meta_box_suppression_option( $enabled );
	if ( is_wp_error( $result ) ) {
		wp_die( esc_html( $result->get_error_message() ), '', array( 'response' => 500 ) );
	}

	wp_safe_redirect( add_query_arg( 'settings-updated', '1', wp_collab_cf_get_settings_page_url() ) );
	exit;
}

/**
 * Remove configured meta box IDs from the block editor's filtered copy.
 *
 * The original inventory is captured for diagnostics. WordPress's persisted
 * global registry, callbacks, save hooks, and meta values remain untouched.
 *
 * @param array $wp_meta_boxes Meta box registry passed through the editor filter.
 * @return array Filtered copy of the registry.
 */
function wp_collab_cf_filter_block_editor_meta_boxes( $wp_meta_boxes ) {
	global $current_screen, $wp_collab_cf_compatibility_adapters, $wp_collab_cf_meta_box_suppression;

	$screen_id       = $current_screen && isset( $current_screen->id ) ? $current_screen->id : '';
	$include_owner   = current_user_can( 'activate_plugins' );
	$original_boxes  = wp_collab_cf_describe_meta_boxes( $wp_meta_boxes, $screen_id, $include_owner );
	$policy          = wp_collab_cf_get_suppressed_meta_box_ids();
	$enabled         = wp_collab_cf_is_meta_box_suppression_enabled();
	$configured_ids  = $policy['ids'];
	$effective       = $enabled && null === $policy['warning'] && ! empty( $configured_ids );
	$matched_ids     = array();
	$filtered_boxes  = $wp_meta_boxes;
	$matched_id_set  = array();
	$policy_valid    = null === $policy['warning'];
	$compatibility   = wp_collab_cf_apply_compatibility_meta_box_policies(
		$filtered_boxes,
		$screen_id,
		$configured_ids,
		$enabled,
		$policy_valid
	);
	$filtered_boxes  = $compatibility['boxes'];
	foreach ( $compatibility['matchedIds'] as $matched_compatibility_id ) {
		$matched_id_set[ $matched_compatibility_id ] = true;
	}
	$wp_collab_cf_compatibility_adapters = $compatibility['diagnostics'];

	if ( $effective && isset( $filtered_boxes[ $screen_id ] ) && is_array( $filtered_boxes[ $screen_id ] ) ) {
		$generic_ids = array_values( array_diff( $configured_ids, $compatibility['handledIds'] ) );
		$configured_id_set = array_fill_keys( $generic_ids, true );
		foreach ( $filtered_boxes[ $screen_id ] as $context => $priorities ) {
			if ( ! is_array( $priorities ) ) {
				continue;
			}
			foreach ( $priorities as $priority => $boxes ) {
				if ( ! is_array( $boxes ) ) {
					continue;
				}
				foreach ( $boxes as $registered_id => $meta_box ) {
					$meta_box_id = is_array( $meta_box ) && isset( $meta_box['id'] )
						? $meta_box['id']
						: $registered_id;
					if ( ! is_string( $meta_box_id ) || ! isset( $configured_id_set[ $meta_box_id ] ) ) {
						continue;
					}
					unset( $filtered_boxes[ $screen_id ][ $context ][ $priority ][ $registered_id ] );
					$matched_id_set[ $meta_box_id ] = true;
				}
			}
		}
	}
	$matched_ids = array_values(
		array_filter(
			$configured_ids,
			function ( $id ) use ( $matched_id_set ) {
				return isset( $matched_id_set[ $id ] );
			}
		)
	);

	$wp_collab_cf_meta_box_suppression = array(
		'configuredIds'  => $configured_ids,
		'enabled'        => $enabled,
		'effective'      => $effective,
		'matchedIds'     => $matched_ids,
		'suppressedIds'  => $matched_ids,
		'unmatchedIds'   => $effective ? array_values( array_diff( $configured_ids, $matched_ids ) ) : array(),
		'remainingBlockerIds' => array(),
		'warning'        => $policy['warning'],
		'originalMetaBoxes' => $original_boxes,
	);

	return $filtered_boxes;
}

/**
 * Return sanitized compatibility adapter diagnostics.
 *
 * @return array MemberPress and Yoast request state.
 */
function wp_collab_cf_get_compatibility_adapter_diagnostics() {
	global $wp_collab_cf_compatibility_adapters;

	$memberpress = isset( $wp_collab_cf_compatibility_adapters['memberpress'] ) && is_array( $wp_collab_cf_compatibility_adapters['memberpress'] )
		? $wp_collab_cf_compatibility_adapters['memberpress']
		: wp_collab_cf_memberpress_default_diagnostics();
	$yoast = isset( $wp_collab_cf_compatibility_adapters['yoast'] ) && is_array( $wp_collab_cf_compatibility_adapters['yoast'] )
		? $wp_collab_cf_compatibility_adapters['yoast']
		: wp_collab_cf_yoast_default_diagnostics();

	return array(
		'memberpress' => $memberpress,
		'yoast'       => $yoast,
	);
}

/**
 * Return the most recent request's sanitized suppression diagnostics.
 *
 * @return array Suppression state.
 */
function wp_collab_cf_get_meta_box_suppression_diagnostics() {
	global $wp_collab_cf_meta_box_suppression;

	if ( isset( $wp_collab_cf_meta_box_suppression ) && is_array( $wp_collab_cf_meta_box_suppression ) ) {
		return $wp_collab_cf_meta_box_suppression;
	}

	return array(
		'configuredIds'      => array(),
		'enabled'            => wp_collab_cf_is_meta_box_suppression_enabled(),
		'effective'          => false,
		'matchedIds'         => array(),
		'suppressedIds'      => array(),
		'unmatchedIds'       => array(),
		'remainingBlockerIds' => array(),
		'warning'            => null,
		'originalMetaBoxes'  => array(),
	);
}

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
	global $current_screen, $wp_collab_cf_diagnostics_meta_boxes, $wp_collab_cf_meta_box_suppression;

	if ( $current_screen && isset( $current_screen->id ) ) {
		$wp_collab_cf_diagnostics_meta_boxes = wp_collab_cf_describe_meta_boxes(
			$wp_meta_boxes,
			$current_screen->id,
			current_user_can( 'activate_plugins' )
		);
		$remaining_blockers = array();
		foreach ( $wp_collab_cf_diagnostics_meta_boxes as $meta_box ) {
			if (
				empty( $meta_box['rtcCompatible'] ) &&
				isset( $meta_box['id'] ) &&
				is_string( $meta_box['id'] ) &&
				'' !== $meta_box['id'] &&
				! in_array( $meta_box['id'], $remaining_blockers, true )
			) {
				$remaining_blockers[] = $meta_box['id'];
			}
		}
		if ( isset( $wp_collab_cf_meta_box_suppression ) && is_array( $wp_collab_cf_meta_box_suppression ) ) {
			$wp_collab_cf_meta_box_suppression['remainingBlockerIds'] = $remaining_blockers;
		}
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
		'metaBoxSuppression'   => wp_collab_cf_get_meta_box_suppression_diagnostics(),
		'compatibilityAdapters' => wp_collab_cf_get_compatibility_adapter_diagnostics(),
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
	register_rest_route(
		'wp-collab-cf/v1',
		'/meta-box-suppression',
		array(
			'methods'             => WP_REST_Server::CREATABLE,
			'callback'            => 'wp_collab_cf_rest_update_meta_box_suppression',
			'permission_callback' => 'wp_collab_cf_can_manage_meta_box_suppression',
		)
	);
}

/**
 * Restrict site-wide suppression policy changes to site administrators.
 *
 * WordPress REST cookie authentication validates the wp_rest nonce before this
 * capability callback runs.
 *
 * @return bool
 */
function wp_collab_cf_can_manage_meta_box_suppression() {
	return current_user_can( 'manage_options' );
}

/**
 * Save the current blog's site-wide meta box suppression state.
 *
 * @param WP_REST_Request $request Request object.
 * @return WP_REST_Response|WP_Error
 */
function wp_collab_cf_rest_update_meta_box_suppression( WP_REST_Request $request ) {
	$json_params = $request->get_json_params();
	if (
		! is_array( $json_params ) ||
		array( 'enabled' ) !== array_keys( $json_params ) ||
		! is_bool( $json_params['enabled'] )
	) {
		return new WP_Error(
			'wp_collab_cf_invalid_suppression_setting',
			'The enabled setting must be an exact boolean and cannot target a user or blog.',
			array( 'status' => 400 )
		);
	}

	$enabled = wp_collab_cf_update_meta_box_suppression_option( $json_params['enabled'] );
	if ( is_wp_error( $enabled ) ) {
		return $enabled;
	}

	$response = rest_ensure_response( array( 'enabled' => $enabled ) );
	$response->header( 'Cache-Control', 'no-store' );
	return $response;
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
	$can_manage = wp_collab_cf_can_manage_meta_box_suppression();
	wp_localize_script(
		'wp-collab-cf',
		'wpCollabCf',
		array(
			'wsUrl'             => $configured ? WP_COLLAB_CF_WS_URL : '',
			'tokenUrl'          => $configured ? rest_url( 'wp-collab-cf/v1/token' ) : '',
			'metaBoxSuppression' => array(
				'canManage'  => $can_manage,
				'enabled'    => wp_collab_cf_is_meta_box_suppression_enabled(),
				'settingsUrl' => $can_manage
					? wp_collab_cf_get_settings_page_url()
					: '',
			),
		)
	);
}
