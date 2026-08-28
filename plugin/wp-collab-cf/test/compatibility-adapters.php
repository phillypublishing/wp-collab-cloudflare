<?php

define( 'ABSPATH', '/wordpress/' );
define( 'WP_PLUGIN_DIR', '/wordpress/wp-content/plugins' );
define( 'WPMU_PLUGIN_DIR', '/wordpress/wp-content/mu-plugins' );
define( 'WPSEO_VERSION', '28.3' );
define( 'WPSEO_PREMIUM_VERSION', '28.3' );
define( 'WPSEO_NEWS_VERSION', '13.4' );
define( 'WPSEO_VIDEO_VERSION', '15.2' );
define( 'WPSEO_LOCAL_VERSION', '15.8' );
define( 'MEPR_VERSION', '1.12.18' );

error_reporting( E_ALL );
set_error_handler(
	function ( $severity, $message, $file, $line ) {
		throw new ErrorException( $message, 0, $severity, $file, $line );
	}
);

$compat_actions = array();
$compat_filters = array();
$compat_options = array(
	'wp_collab_cf_meta_box_suppression_enabled' => true,
	'active_plugins' => array(
		'wordpress-seo/wp-seo.php',
		'wordpress-seo-premium/wp-seo-premium.php',
		'wpseo-video/video-seo.php',
		'wpseo-local/local-seo.php',
	),
);
$compat_site_options = array();
$compat_posts = array();
$compat_parsed_blocks = array();
$compat_current_user_can_activate_plugins = true;
$compat_read_post_permissions = array();
$compat_get_post_calls = 0;
$compat_scripts = null;
$compat_styles = null;
$compat_parse_blocks_calls = 0;
$compat_policy_filter_calls = 0;
$compat_registered_post_meta = array();
$compat_edit_post_permissions = array();
$compat_user_edit_post_permissions = array();
$compat_yoast_reindexed_post_ids = array();
$compat_yoast_requested_classes = array();
$compat_yoast_service_mode = 'valid';
$compat_policy_contexts = array();
$compat_policy_filter_mode = 'valid';

function add_action( $hook, $callback, $priority = 10, $accepted_args = 1 ) {
	global $compat_actions;
	$compat_actions[ $hook ][ $priority ][] = compact( 'callback', 'accepted_args' );
}

function add_filter( $hook, $callback, $priority = 10, $accepted_args = 1 ) {
	global $compat_filters;
	$compat_filters[ $hook ][ $priority ][] = compact( 'callback', 'accepted_args' );
}

function compat_run_callbacks( $registrations, $value, $args ) {
	ksort( $registrations );
	foreach ( $registrations as $callbacks ) {
		foreach ( $callbacks as $registration ) {
			$call_args = array_slice( array_merge( array( $value ), $args ), 0, $registration['accepted_args'] );
			$value = call_user_func_array( $registration['callback'], $call_args );
		}
	}
	return $value;
}

function apply_filters( $hook, $value, ...$args ) {
	global $compat_filters;
	return isset( $compat_filters[ $hook ] )
		? compat_run_callbacks( $compat_filters[ $hook ], $value, $args )
		: $value;
}

function do_action( $hook, ...$args ) {
	global $compat_actions;
	if ( empty( $compat_actions[ $hook ] ) ) {
		return;
	}
	ksort( $compat_actions[ $hook ] );
	foreach ( $compat_actions[ $hook ] as $callbacks ) {
		foreach ( $callbacks as $registration ) {
			call_user_func_array( $registration['callback'], array_slice( $args, 0, $registration['accepted_args'] ) );
		}
	}
}

function get_option( $name, $default = false ) {
	global $compat_options;
	return array_key_exists( $name, $compat_options ) ? $compat_options[ $name ] : $default;
}

function get_site_option( $name, $default = false ) {
	global $compat_site_options;
	return array_key_exists( $name, $compat_site_options ) ? $compat_site_options[ $name ] : $default;
}

function current_user_can( $capability, ...$args ) {
	global $compat_current_user_can_activate_plugins, $compat_read_post_permissions, $compat_edit_post_permissions;
	if ( 'activate_plugins' === $capability ) {
		return $compat_current_user_can_activate_plugins;
	}
	if ( 'read_post' === $capability ) {
		$post_id = isset( $args[0] ) ? $args[0] : null;
		return ! array_key_exists( $post_id, $compat_read_post_permissions ) || true === $compat_read_post_permissions[ $post_id ];
	}
	if ( 'edit_post' === $capability ) {
		$post_id = isset( $args[0] ) ? $args[0] : null;
		return ! array_key_exists( $post_id, $compat_edit_post_permissions ) || true === $compat_edit_post_permissions[ $post_id ];
	}
	return true;
}

function user_can( $user_id, $capability, ...$args ) {
	global $compat_user_edit_post_permissions;
	if ( 'edit_post' !== $capability ) {
		return true;
	}

	$post_id = isset( $args[0] ) ? $args[0] : null;
	$key     = (int) $user_id . ':' . $post_id;
	return ! array_key_exists( $key, $compat_user_edit_post_permissions ) || true === $compat_user_edit_post_permissions[ $key ];
}

function register_post_meta( $post_type, $meta_key, $args ) {
	global $compat_registered_post_meta;
	$compat_registered_post_meta[ $post_type ][ $meta_key ] = $args;
	return true;
}

function registered_meta_key_exists( $object_type, $meta_key, $object_subtype = '' ) {
	global $compat_registered_post_meta;
	return isset( $compat_registered_post_meta[ $object_subtype ][ $meta_key ] );
}

function get_post_types() {
	return array( 'post', 'page' );
}

function get_current_screen() {
	global $current_screen;
	return $current_screen;
}

function parse_blocks( $content ) {
	global $compat_parse_blocks_calls, $compat_parsed_blocks;
	++$compat_parse_blocks_calls;
	if ( ! array_key_exists( $content, $compat_parsed_blocks ) ) {
		throw new RuntimeException( 'Unreadable block fixture.' );
	}
	return $compat_parsed_blocks[ $content ];
}

function get_post( $post_id ) {
	global $compat_get_post_calls, $compat_posts;
	++$compat_get_post_calls;
	return isset( $compat_posts[ $post_id ] ) ? $compat_posts[ $post_id ] : null;
}

function wp_scripts() {
	global $compat_scripts;
	return $compat_scripts;
}

function wp_styles() {
	global $compat_styles;
	return $compat_styles;
}

function wp_dequeue_script( $handle ) {
	global $compat_scripts;
	$compat_scripts->queue = array_values( array_diff( $compat_scripts->queue, array( $handle ) ) );
}

function wp_dequeue_style( $handle ) {
	global $compat_styles;
	$compat_styles->queue = array_values( array_diff( $compat_styles->queue, array( $handle ) ) );
}

function wp_strip_all_tags( $value ) {
	return strip_tags( $value );
}

function wp_normalize_path( $value ) {
	return str_replace( '\\', '/', $value );
}

function update_option( $name, $value ) {
	global $compat_options;
	$compat_options[ $name ] = $value;
	return true;
}

function register_rest_route() {}
function rest_ensure_response( $data ) { return $data; }
function is_wp_error() { return false; }

class WP_Post {
	public $ID;
	public $post_type;
	public $post_content;

	public function __construct( $id, $post_type, $post_content ) {
		$this->ID = $id;
		$this->post_type = $post_type;
		$this->post_content = $post_content;
	}
}

class Compat_REST_Response {
	private $data;

	public function __construct( $data ) {
		$this->data = $data;
	}

	public function get_data() {
		return $this->data;
	}

	public function set_data( $data ) {
		$this->data = $data;
	}
}

class Compat_REST_Request {
	private $params;

	public function __construct( $params = array() ) {
		$this->params = $params;
	}

	public function has_param( $key ) {
		return array_key_exists( $key, $this->params );
	}
}

class Compat_Yoast_Indexable_Post_Watcher {
	public function build_indexable( $post_id ) {
		global $compat_yoast_reindexed_post_ids, $compat_yoast_service_mode;
		if ( 'throw_build' === $compat_yoast_service_mode ) {
			throw new RuntimeException( 'Yoast watcher unavailable.' );
		}
		$compat_yoast_reindexed_post_ids[] = $post_id;
	}
}

class Compat_Yoast_Classes_Surface {
	public function get( $class_name ) {
		global $compat_yoast_requested_classes, $compat_yoast_service_mode;
		$compat_yoast_requested_classes[] = $class_name;
		if ( 'Yoast\\WP\\SEO\\Integrations\\Watchers\\Indexable_Post_Watcher' !== $class_name ) {
			throw new RuntimeException( 'Unexpected Yoast service.' );
		}
		if ( 'throw_get' === $compat_yoast_service_mode ) {
			throw new RuntimeException( 'Yoast container unavailable.' );
		}
		if ( 'missing_method' === $compat_yoast_service_mode ) {
			return new stdClass();
		}
		return new Compat_Yoast_Indexable_Post_Watcher();
	}
}

function YoastSEO() {
	return (object) array(
		'classes' => new Compat_Yoast_Classes_Surface(),
	);
}

class WP_Screen {
	public $id;
	public $post_type;
	private $block_editor;

	public function __construct( $block_editor = true, $post_type = 'post' ) {
		$this->block_editor = $block_editor;
		$this->id = $post_type;
		$this->post_type = $post_type;
	}

	public static function get( $post_type = 'post' ) {
		return new static( true, $post_type );
	}

	public function is_block_editor() {
		return $this->block_editor;
	}
}

class Compat_Screen extends WP_Screen {}

class MeprAppCtrl {
	public function unauthorized_meta_box() {}
}

class WrongMeprAppCtrl {
	public function unauthorized_meta_box() {}
}

class Compat_Dependency {
	public $deps;

	public function __construct( $deps = array() ) {
		$this->deps = $deps;
	}
}

class Compat_Dependencies {
	public $registered = array();
	public $queue = array();
	public $to_do = array();
	public $done = array();

	public function add( $handle, $deps = array(), $queued = true ) {
		$this->registered[ $handle ] = new Compat_Dependency( $deps );
		if ( $queued ) {
			$this->queue[] = $handle;
			$this->to_do[] = $handle;
		}
	}
}

function compat_assert_same( $expected, $actual, $message ) {
	if ( $expected !== $actual ) {
		fwrite( STDERR, $message . "\nExpected: " . var_export( $expected, true ) . "\nActual: " . var_export( $actual, true ) . "\n" );
		exit( 1 );
	}
}

function compat_assert_true( $actual, $message ) {
	compat_assert_same( true, $actual, $message );
}

function compat_box( $id, $callback ) {
	return array(
		'id' => $id,
		'title' => $id,
		'callback' => $callback,
		'args' => array(),
	);
}

function compat_registry( $boxes ) {
	return array(
		'post' => array(
			'normal' => array(
				'high' => $boxes,
			),
		),
	);
}

function compat_reset_adapter_state() {
	unset(
		$GLOBALS['wp_collab_cf_compatibility_adapters'],
		$GLOBALS['wp_collab_cf_meta_box_suppression'],
		$GLOBALS['wp_collab_cf_yoast_stable_request_diagnostics'],
		$GLOBALS['wp_collab_cf_yoast_unexpected_dependency_handles']
	);
}

require dirname( __DIR__ ) . '/wp-collab-cf.php';

compat_assert_true(
	function_exists( 'wp_collab_cf_memberpress_filter_meta_boxes' ),
	'The MemberPress compatibility module must be loaded by the plugin.'
);
compat_assert_true(
	function_exists( 'wp_collab_cf_yoast_filter_editor_features' ),
	'The Yoast compatibility module must be loaded by the plugin.'
);
compat_assert_same( false, isset( $compat_actions['wp_print_head_scripts'] ), 'The adapter must not rely on the inert wp_print_head_scripts hook.' );
compat_assert_true( isset( $compat_actions['admin_enqueue_scripts'][ PHP_INT_MAX ] ), 'Enqueue pruning must run after ordinary admin enqueuers.' );
compat_assert_same(
	array( 'wp_collab_cf_yoast_prune_editor_assets', 'wp_collab_cf_enqueue_scripts' ),
	array_column( $compat_actions['admin_enqueue_scripts'][ PHP_INT_MAX ], 'callback' ),
	'The plugin bundle must read Yoast diagnostics only after the final enqueue-pruning pass.'
);
compat_assert_true( isset( $compat_actions['admin_print_scripts'][19] ), 'Admin-head script pruning must run before Core prints at priority 20.' );
compat_assert_true( isset( $compat_actions['admin_print_styles'][19] ), 'Admin-head style pruning must run before Core prints at priority 20.' );
compat_assert_true( isset( $compat_actions['admin_print_footer_scripts'][9] ), 'Admin-footer pruning must run before Core prints at priority 10.' );
compat_assert_same( false, isset( $compat_actions['wp_print_footer_scripts'] ), 'The admin adapter must not register a front-end footer seam.' );
compat_assert_same( false, isset( $compat_actions['wp_print_styles'] ), 'The admin adapter must not register a front-end style seam.' );
do_action( 'init' );
compat_assert_true( isset( $compat_filters['wpseo_enable_editor_features_post'][ PHP_INT_MAX ] ), 'The owner filter must be registered at init before post meta boxes and admin enqueue run.' );
compat_assert_true( isset( $compat_actions['rest_after_insert_post'][ PHP_INT_MAX ] ), 'The featured-image bridge must follow REST saves for posts.' );
compat_assert_true( isset( $compat_actions['rest_after_insert_page'][ PHP_INT_MAX ] ), 'The featured-image bridge must cover every post type whose Yoast editor can be suppressed.' );
compat_assert_true(
	isset( $compat_registered_post_meta['post'][ WP_COLLAB_CF_YOAST_PRIMARY_CATEGORY_META_KEY ] ),
	'The RTC bridge must register Yoast primary category meta for the post REST response.'
);
$compat_options['wp_collab_cf_meta_box_suppression_enabled'] = false;
$compat_registered_post_meta = array();
compat_assert_same( false, wp_collab_cf_yoast_register_primary_category_meta(), 'A disabled site policy must not register primary category REST meta.' );
compat_assert_same( array(), $compat_registered_post_meta, 'A disabled site policy must leave the REST meta registry untouched.' );
$compat_options['wp_collab_cf_meta_box_suppression_enabled'] = true;
compat_assert_same( true, wp_collab_cf_yoast_register_primary_category_meta(), 'Re-enabled suppression must restore primary category REST registration.' );
$primary_category_meta = $compat_registered_post_meta['post'][ WP_COLLAB_CF_YOAST_PRIMARY_CATEGORY_META_KEY ];
compat_assert_same( true, $primary_category_meta['show_in_rest'], 'Primary category meta must be visible to the authenticated editor REST response.' );
compat_assert_same( true, $primary_category_meta['single'], 'Primary category meta must remain a scalar.' );
compat_assert_same( 'string', $primary_category_meta['type'], 'Primary category meta must preserve Yoast\'s string storage contract.' );
compat_assert_same( '42', call_user_func( $primary_category_meta['sanitize_callback'], '0042' ), 'Primary category IDs must be normalized to positive integer strings.' );
compat_assert_same( '', call_user_func( $primary_category_meta['sanitize_callback'], '42x' ), 'Malformed primary category IDs must be rejected.' );
compat_assert_same( '', call_user_func( $primary_category_meta['sanitize_callback'], array( 42 ) ), 'Non-scalar primary category IDs must be rejected.' );
compat_assert_same( '', call_user_func( $primary_category_meta['sanitize_callback'], '000' ), 'Zero is not a valid primary category ID.' );
compat_assert_same( '', call_user_func( $primary_category_meta['sanitize_callback'], (string) PHP_INT_MAX . '0' ), 'Overflowing primary category IDs must be rejected.' );
compat_assert_same( true, call_user_func( $primary_category_meta['auth_callback'], false, WP_COLLAB_CF_YOAST_PRIMARY_CATEGORY_META_KEY, 42 ), 'Editors must be allowed to update primary category meta.' );
$compat_edit_post_permissions[42] = false;
compat_assert_same( false, call_user_func( $primary_category_meta['auth_callback'], true, '_yoast_wpseo_primary_category', 42 ), 'Users who cannot edit the post must not update primary category meta.' );
$compat_user_edit_post_permissions['7:42'] = true;
compat_assert_same( true, call_user_func( $primary_category_meta['auth_callback'], false, WP_COLLAB_CF_YOAST_PRIMARY_CATEGORY_META_KEY, 42, 7 ), 'Explicit user capability checks must evaluate the named editor.' );
$compat_user_edit_post_permissions['7:42'] = false;
compat_assert_same( false, call_user_func( $primary_category_meta['auth_callback'], true, WP_COLLAB_CF_YOAST_PRIMARY_CATEGORY_META_KEY, 42, 7 ), 'Explicit user capability checks must reject the named non-editor.' );
$public_primary_response = new Compat_REST_Response(
	array(
		'meta' => array(
			WP_COLLAB_CF_YOAST_PRIMARY_CATEGORY_META_KEY => '42',
			'public_meta' => 'preserved',
		),
	)
);
wp_collab_cf_yoast_hide_primary_category_meta( $public_primary_response, new WP_Post( 42, 'post', '' ) );
compat_assert_same(
	array( 'public_meta' => 'preserved' ),
	$public_primary_response->get_data()['meta'],
	'Public REST responses must remove only Yoast primary category meta.'
);
unset( $compat_edit_post_permissions[42] );
$editor_primary_response = new Compat_REST_Response(
	array(
		'meta' => array(
			WP_COLLAB_CF_YOAST_PRIMARY_CATEGORY_META_KEY => '42',
		),
	)
);
$editor_primary_response = apply_filters( 'rest_prepare_post', $editor_primary_response, new WP_Post( 42, 'post', '' ) );
compat_assert_same(
	array( WP_COLLAB_CF_YOAST_PRIMARY_CATEGORY_META_KEY => '42' ),
	$editor_primary_response->get_data()['meta'],
	'Authenticated editor REST responses must preserve primary category meta for Gutenberg sync.'
);
compat_assert_true( isset( $compat_filters['rest_prepare_post'][10] ), 'Public REST responses must strip the protected primary category meta.' );

$current_screen = new Compat_Screen( true );
$post = new WP_Post( 42, 'post', 'safe' );
$compat_options['wp_collab_cf_meta_box_suppression_enabled'] = true;
$compat_parsed_blocks = array(
	'safe' => array(
		array( 'blockName' => 'core/paragraph', 'attrs' => array(), 'innerBlocks' => array() ),
	),
	'direct-protected' => array(
		array( 'blockName' => 'yoast-seo/related-links', 'attrs' => array(), 'innerBlocks' => array() ),
	),
	'direct-content-suggestion' => array(
		array( 'blockName' => 'yoast-seo/content-suggestion', 'attrs' => array(), 'innerBlocks' => array() ),
	),
	'nested-protected' => array(
		array(
			'blockName' => 'core/group',
			'attrs' => array(),
			'innerBlocks' => array(
				array( 'blockName' => 'yoast-seo/table-of-contents', 'attrs' => array(), 'innerBlocks' => array() ),
			),
		),
	),
	'synced-protected' => array(
		array( 'blockName' => 'core/block', 'attrs' => array( 'ref' => 100 ), 'innerBlocks' => array() ),
	),
	'synced-cycle' => array(
		array( 'blockName' => 'core/block', 'attrs' => array( 'ref' => 101 ), 'innerBlocks' => array() ),
	),
	'synced-missing' => array(
		array( 'blockName' => 'core/block', 'attrs' => array( 'ref' => 999 ), 'innerBlocks' => array() ),
	),
	'ref-100' => array(
		array( 'blockName' => 'yoast-seo/ai-summarize', 'attrs' => array(), 'innerBlocks' => array() ),
	),
	'ref-101' => array(
		array( 'blockName' => 'core/block', 'attrs' => array( 'ref' => 101 ), 'innerBlocks' => array() ),
	),
);
$compat_posts[100] = new WP_Post( 100, 'wp_block', 'ref-100' );
$compat_posts[101] = new WP_Post( 101, 'wp_block', 'ref-101' );

$inspection = wp_collab_cf_yoast_inspect_post_content( 'safe' );
compat_assert_same( 'safe', $inspection['state'], 'Ordinary blocks should be eligible.' );
compat_assert_same( 'protected', wp_collab_cf_yoast_inspect_post_content( 'direct-protected' )['state'], 'A direct protected Yoast block must fail closed.' );
compat_assert_same( 'protected', wp_collab_cf_yoast_inspect_post_content( 'direct-content-suggestion' )['state'], 'The content-suggestion block must fail closed.' );
compat_assert_same( 'protected', wp_collab_cf_yoast_inspect_post_content( 'nested-protected' )['state'], 'A nested protected Yoast block must fail closed.' );
compat_assert_same( 'protected', wp_collab_cf_yoast_inspect_post_content( 'synced-protected' )['state'], 'A protected block in synced content must fail closed.' );
compat_assert_same( 'uncertain', wp_collab_cf_yoast_inspect_post_content( 'synced-cycle' )['state'], 'A synced-content cycle must fail closed.' );
compat_assert_same( 'uncertain', wp_collab_cf_yoast_inspect_post_content( 'synced-missing' )['state'], 'A missing synced reference must fail closed.' );
compat_assert_same( 'uncertain', wp_collab_cf_yoast_inspect_post_content( 'unreadable-content' )['state'], 'Unreadable post blocks must fail closed.' );

$compat_read_post_permissions[100] = false;
$compat_get_post_calls = 0;
$compat_parse_blocks_calls = 0;
$permission_denied = wp_collab_cf_yoast_inspect_post_content( 'synced-protected' );
compat_assert_same( 'uncertain', $permission_denied['state'], 'An unreadable synced reference must fail closed.' );
compat_assert_same( 'synced_ref_unavailable', $permission_denied['reason'], 'Permission denial must use the same opaque unavailable reason as an unreadable reference.' );
compat_assert_same( 0, $compat_get_post_calls, 'Permission must be checked before loading synced post content.' );
compat_assert_same( 1, $compat_parse_blocks_calls, 'Denied synced content must not be parsed.' );
unset( $compat_read_post_permissions[100] );

$too_deep = array( 'blockName' => 'core/paragraph', 'attrs' => array(), 'innerBlocks' => array() );
for ( $depth = 0; $depth < 40; $depth++ ) {
	$too_deep = array( 'blockName' => 'core/group', 'attrs' => array(), 'innerBlocks' => array( $too_deep ) );
}
$compat_parsed_blocks['too-deep'] = array( $too_deep );
compat_assert_same( 'uncertain', wp_collab_cf_yoast_inspect_post_content( 'too-deep' )['state'], 'Traversal bounds must fail closed.' );

compat_assert_true( wp_collab_cf_yoast_versions_supported( '28.2', '28.2' ), 'The minimum supported Yoast pair should be supported.' );
compat_assert_true( wp_collab_cf_yoast_versions_supported( '28.2.1', '28.3' ), 'Newer Yoast Core and Premium releases should remain supported.' );
compat_assert_true( wp_collab_cf_yoast_versions_supported( '29.0', '29.1' ), 'Yoast support should not impose an upper version bound.' );
compat_assert_same( false, wp_collab_cf_yoast_versions_supported( '28.1.99', '28.3' ), 'Yoast Core below the minimum must be rejected.' );
compat_assert_same( false, wp_collab_cf_yoast_versions_supported( '28.3', '28.1.99' ), 'Yoast Premium below the minimum must be rejected.' );
compat_assert_same( false, wp_collab_cf_yoast_versions_supported( 'not-a-version', '28.3' ), 'Malformed Yoast versions must be rejected.' );
compat_assert_true( wp_collab_cf_memberpress_version_supported( '1.12.17' ), 'The minimum supported MemberPress version should be supported.' );
compat_assert_true( wp_collab_cf_memberpress_version_supported( '1.12.18' ), 'Newer MemberPress releases should remain supported.' );
compat_assert_true( wp_collab_cf_memberpress_version_supported( '2.0' ), 'MemberPress support should not impose an upper version bound.' );
compat_assert_same( false, wp_collab_cf_memberpress_version_supported( '1.12.16' ), 'MemberPress versions below the minimum must be rejected.' );
compat_assert_same( false, wp_collab_cf_memberpress_version_supported( 'not-a-version' ), 'Malformed MemberPress versions must be rejected.' );
$memberpress_diagnostics = wp_collab_cf_memberpress_default_diagnostics();
compat_assert_same( 'memberpress_scale_1_12_17', $memberpress_diagnostics['adapter'], 'The diagnostics/v1 MemberPress adapter ID must remain stable.' );
compat_assert_same( 'memberpress_scale', $memberpress_diagnostics['policyId'], 'MemberPress diagnostics should expose a version-independent policy ID.' );
compat_assert_same( 'minimum', $memberpress_diagnostics['versionPolicy'], 'MemberPress diagnostics should expose the minimum-version policy.' );
compat_assert_same( '1.12.17', $memberpress_diagnostics['minimumVersions']['memberpress'], 'MemberPress diagnostics should expose the supported minimum.' );
$yoast_diagnostics = wp_collab_cf_yoast_default_diagnostics();
compat_assert_same( 'yoast_seo_core_premium_28_2', $yoast_diagnostics['adapter'], 'The diagnostics/v1 Yoast adapter ID must remain stable.' );
compat_assert_same( 'yoast_seo_core_premium', $yoast_diagnostics['policyId'], 'Yoast diagnostics should expose a version-independent policy ID.' );
compat_assert_same( 'minimum', $yoast_diagnostics['versionPolicy'], 'Yoast diagnostics should expose the minimum-version policy.' );
compat_assert_same(
	array(
		'core'    => '28.2',
		'premium' => '28.2',
		'news'    => '13.3',
		'video'   => '15.2',
		'local'   => '15.8',
	),
	$yoast_diagnostics['minimumVersions'],
	'Yoast diagnostics should expose each supported minimum.'
);
compat_assert_same(
	array(),
	wp_collab_cf_yoast_find_unsupported_addons( $compat_options['active_plugins'] ),
	'The exact Core and Premium basenames are allowed.'
);
compat_assert_same(
	array(),
	wp_collab_cf_yoast_find_unsupported_addons(
		array_merge( $compat_options['active_plugins'], array( 'wordpress-seo-news/wpseo-news.php' ) )
	),
	'The exact News main plugin file is handled by its own version policy.'
);
compat_assert_same(
	array(),
	wp_collab_cf_yoast_find_unsupported_addons(
		array_merge(
			array_slice( $compat_options['active_plugins'], 0, 2 ),
			array( 'yoast-video-folder/video-seo.php', 'wordpress-seo-local-folder/local-seo.php' )
		)
	),
	'The Video and Local main plugin files are handled by their own version policies regardless of folder name.'
);
$yoast_duplicate_addon_classification = wp_collab_cf_yoast_classify_addons(
	array(
		'yoast-video-one/video-seo.php',
		'wordpress-seo-video-two/video-seo.php',
		'yoast-local-one/local-seo.php',
		'wordpress-seo-local-two/local-seo.php',
	)
);
compat_assert_same( array(), $yoast_duplicate_addon_classification['unsupported'], 'Duplicate supported add-on basenames must not be classified as unsupported.' );
compat_assert_same( 2, $yoast_duplicate_addon_classification['basenameCounts']['video'], 'Two distinct Video folders with video-seo.php must count as two Video add-ons.' );
compat_assert_same( 2, $yoast_duplicate_addon_classification['basenameCounts']['local'], 'Two distinct Local folders with local-seo.php must count as two Local add-ons.' );
compat_assert_true( wp_collab_cf_yoast_news_version_supported( '13.3' ), 'The minimum supported Yoast News version should be supported.' );
compat_assert_true( wp_collab_cf_yoast_news_version_supported( '13.4' ), 'Newer Yoast News releases should remain supported.' );
compat_assert_true( wp_collab_cf_yoast_news_version_supported( '14.0' ), 'Yoast News support should not impose an upper version bound.' );
compat_assert_same( false, wp_collab_cf_yoast_news_version_supported( '13.2.99' ), 'Yoast News versions below the minimum must be rejected.' );
compat_assert_same( false, wp_collab_cf_yoast_news_version_supported( 'not-a-version' ), 'Malformed Yoast News versions must be rejected.' );
compat_assert_same(
	array( 'unsupported' ),
	wp_collab_cf_yoast_find_unsupported_addons(
		array_merge( $compat_options['active_plugins'], array( 'woocommerce-seo/wpseo-woocommerce.php' ) )
	),
	'An active wpseo-named add-on must be rejected.'
);

$compat_scripts = new Compat_Dependencies();
$compat_scripts->add( 'yoast-seo-post-edit', array( 'yoast-seo-block-editor' ) );
$compat_scripts->add( 'yoast-seo-block-editor' );
$compat_scripts->add( 'wp-seo-premium-blocks', array( 'yoast-seo-premium-metabox' ) );
$compat_scripts->add( 'yoast-seo-premium-metabox' );
$compat_scripts->add( 'wp-seo-premium-redirect-notifications-gutenberg' );
$compat_scripts->add( 'wp-seo-premium-dynamic-blocks' );
compat_assert_same(
	array(),
	wp_collab_cf_yoast_find_unexpected_reverse_dependencies( $compat_scripts ),
	'The exact denied graph should not report its own edges as unexpected.'
);
$compat_scripts->add( 'unexpected-addon-entry', array( 'yoast-seo-post-edit' ) );
compat_assert_same(
	array( 'unexpected-addon-entry' ),
	wp_collab_cf_yoast_find_unexpected_reverse_dependencies( $compat_scripts ),
	'An unexpected reverse dependency must be identified.'
);

add_filter(
	'wp_collab_cf_suppressed_meta_box_ids',
	function ( $ids, WP_Screen $screen, WP_Post $context_post ) {
		global $compat_policy_filter_calls, $compat_policy_ids, $compat_policy_contexts, $compat_policy_filter_mode;
		++$compat_policy_filter_calls;
		$compat_policy_contexts[] = array( $screen->id, $context_post->ID );
		if ( 'throw' === $compat_policy_filter_mode ) {
			throw new RuntimeException( 'Suppression policy unavailable.' );
		}
		return $compat_policy_ids;
	},
	10,
	3
);

$compat_policy_ids = array( 'wpseo_meta' );
$compat_policy_filter_calls = 0;
$compat_yoast_reindexed_post_ids = array();
$compat_yoast_requested_classes = array();
$compat_policy_contexts = array();
$current_screen = new Compat_Screen( true, 'page' );
$post = new WP_Post( 99, 'page', 'safe' );
do_action(
	'rest_after_insert_post',
	new WP_Post( 42, 'post', 'safe' ),
	new Compat_REST_Request( array( 'featured_media' => 73 ) ),
	false
);
compat_assert_same( array( 42 ), $compat_yoast_reindexed_post_ids, 'A REST featured-image change must rebuild the Yoast indexable after WordPress applies featured_media.' );
compat_assert_same( array( array( 'post', 42 ) ), $compat_policy_contexts, 'The REST bridge must evaluate the suppression policy with the saved post and its editor screen.' );
compat_assert_same(
	array( 'Yoast\\WP\\SEO\\Integrations\\Watchers\\Indexable_Post_Watcher' ),
	$compat_yoast_requested_classes,
	'The featured-image bridge must reuse Yoast\'s own post watcher.'
);
$current_screen = new Compat_Screen( true );
$post = new WP_Post( 42, 'post', 'safe' );
do_action(
	'rest_after_insert_post',
	new WP_Post( 42, 'post', 'safe' ),
	new Compat_REST_Request( array( 'featured_media' => 0 ) ),
	false
);
compat_assert_same( array( 42, 42 ), $compat_yoast_reindexed_post_ids, 'Removing a REST featured image must rebuild Yoast so the stale og:image is cleared.' );
do_action(
	'rest_after_insert_post',
	new WP_Post( 42, 'post', 'safe' ),
	new Compat_REST_Request(),
	false
);
compat_assert_same( array( 42, 42 ), $compat_yoast_reindexed_post_ids, 'A REST save without featured_media must not perform a duplicate Yoast rebuild.' );
$compat_options['wp_collab_cf_meta_box_suppression_enabled'] = false;
do_action(
	'rest_after_insert_post',
	new WP_Post( 42, 'post', 'safe' ),
	new Compat_REST_Request( array( 'featured_media' => 0 ) ),
	false
);
compat_assert_same( array( 42, 42 ), $compat_yoast_reindexed_post_ids, 'A disabled site policy must not alter Yoast indexables.' );
$compat_options['wp_collab_cf_meta_box_suppression_enabled'] = true;
$compat_policy_ids = array();
do_action(
	'rest_after_insert_post',
	new WP_Post( 42, 'post', 'safe' ),
	new Compat_REST_Request( array( 'featured_media' => 73 ) ),
	false
);
compat_assert_same( array( 42, 42 ), $compat_yoast_reindexed_post_ids, 'An unconfigured Yoast adapter must not alter Yoast indexables.' );
$compat_policy_ids = array( 'wpseo_meta' );
foreach ( array( 'throw_get', 'missing_method', 'throw_build' ) as $compat_yoast_service_mode ) {
	do_action(
		'rest_after_insert_post',
		new WP_Post( 42, 'post', 'safe' ),
		new Compat_REST_Request( array( 'featured_media' => 73 ) ),
		false
	);
}
compat_assert_same( array( 42, 42 ), $compat_yoast_reindexed_post_ids, 'Unavailable Yoast internals must fail closed without reporting a rebuild.' );
$compat_yoast_service_mode = 'valid';
$compat_policy_filter_mode = 'throw';
do_action(
	'rest_after_insert_post',
	new WP_Post( 42, 'post', 'safe' ),
	new Compat_REST_Request( array( 'featured_media' => 73 ) ),
	false
);
compat_assert_same( array( 42, 42 ), $compat_yoast_reindexed_post_ids, 'A failing suppression-policy filter must not fail the REST save or report a rebuild.' );
$compat_policy_filter_mode = 'valid';
do_action(
	'rest_after_insert_page',
	new WP_Post( 43, 'page', 'safe' ),
	new Compat_REST_Request( array( 'featured_media' => 74 ) ),
	false
);
compat_assert_same( array( 42, 42, 43 ), $compat_yoast_reindexed_post_ids, 'Every suppressed REST post type must rebuild after a featured-image change.' );
$compat_policy_ids = array( 'wpseo_meta' );
$compat_policy_filter_calls = 0;
$current_screen = new Compat_Screen( false );
compat_reset_adapter_state();
$not_block_editor = wp_collab_cf_yoast_get_stable_request_diagnostics();
compat_assert_same( 'not_block_editor_post_screen', $not_block_editor['reason'], 'Non-block-editor requests must stop before policy evaluation.' );
compat_assert_same( 0, $compat_policy_filter_calls, 'Yoast policy must not be read outside a real block-editor post screen.' );
compat_assert_same( false, isset( $GLOBALS['wp_collab_cf_yoast_stable_request_diagnostics'] ), 'A transient non-editor screen result must not enter the stable cache.' );
$current_screen = new Compat_Screen( true );
$block_editor = wp_collab_cf_yoast_get_stable_request_diagnostics();
compat_assert_same( true, $block_editor['eligible'], 'The same request must be reevaluated after the block-editor screen becomes available.' );
compat_assert_same( false, wp_collab_cf_yoast_primary_category_editor_config()['enabled'], 'Stable eligibility alone must not enable the bridge before owner suppression and asset pruning finish.' );
compat_assert_same( 1, $compat_policy_filter_calls, 'The suppression policy should be read once after screen confirmation.' );
compat_reset_adapter_state();

$compat_policy_ids = array();
$unconfigured_boxes = compat_registry(
	array(
		'mepr_unauthorized_message' => compat_box( 'mepr_unauthorized_message', 'MeprAppCtrl::unauthorized_meta_box' ),
		'wpseo_meta' => compat_box( 'wpseo_meta', 'strlen' ),
	)
);
compat_reset_adapter_state();
$filtered = wp_collab_cf_filter_block_editor_meta_boxes( $unconfigured_boxes );
compat_assert_true( isset( $filtered['post']['normal']['high']['mepr_unauthorized_message'] ), 'Unconfigured MemberPress must remain present.' );
compat_assert_true( isset( $filtered['post']['normal']['high']['wpseo_meta'] ), 'Unconfigured Yoast must remain present.' );
$unconfigured = wp_collab_cf_get_compatibility_adapter_diagnostics();
compat_assert_same( 'not_configured', $unconfigured['memberpress']['reason'], 'Unconfigured MemberPress state was not reported.' );
compat_assert_same( 'not_configured', $unconfigured['yoast']['reason'], 'Unconfigured Yoast state was not reported.' );

$compat_policy_ids = array( 'generic-box', 'mepr_unauthorized_message' );
$memberpress_boxes = compat_registry(
	array(
		'generic-box' => compat_box( 'generic-box', 'strlen' ),
		'mepr_unauthorized_message' => compat_box(
			'mepr_unauthorized_message',
			'MeprAppCtrl::unauthorized_meta_box'
		),
	)
);
$filtered = wp_collab_cf_filter_block_editor_meta_boxes( $memberpress_boxes );
compat_assert_same( false, isset( $filtered['post']['normal']['high']['generic-box'] ), 'Generic suppression must remain intact.' );
compat_assert_same( false, isset( $filtered['post']['normal']['high']['mepr_unauthorized_message'] ), 'The exact MemberPress box must be removed as a complete registry entry.' );
$diagnostics = wp_collab_cf_get_compatibility_adapter_diagnostics();
compat_assert_same( true, $diagnostics['memberpress']['eligible'], 'MemberPress eligibility was not reported.' );
compat_assert_same( true, $diagnostics['memberpress']['applied'], 'MemberPress application was not reported.' );
compat_assert_same( 'applied', $diagnostics['memberpress']['reason'], 'MemberPress needs a stable applied reason.' );
compat_assert_same( '1.12.18', $diagnostics['memberpress']['version'], 'MemberPress diagnostics must report only the version.' );

compat_reset_adapter_state();
$memberpress_mismatch = compat_registry(
	array(
		'mepr_unauthorized_message' => compat_box(
			'mepr_unauthorized_message',
			array( new MeprAppCtrl(), 'unauthorized_meta_box' )
		),
	)
);
$filtered = wp_collab_cf_filter_block_editor_meta_boxes( $memberpress_mismatch );
compat_assert_true( isset( $filtered['post']['normal']['high']['mepr_unauthorized_message'] ), 'Callback drift must keep the MemberPress box present.' );
compat_assert_same( 'callback_mismatch', wp_collab_cf_get_compatibility_adapter_diagnostics()['memberpress']['reason'], 'Callback drift must be diagnosed.' );

compat_reset_adapter_state();
$filtered = wp_collab_cf_filter_block_editor_meta_boxes( compat_registry( array() ) );
compat_assert_same( 'meta_box_absent', wp_collab_cf_get_compatibility_adapter_diagnostics()['memberpress']['reason'], 'A missing MemberPress box should remain a normal unmatched configuration.' );
compat_assert_true( in_array( 'mepr_unauthorized_message', wp_collab_cf_get_meta_box_suppression_diagnostics()['unmatchedIds'], true ), 'An absent MemberPress box should remain unmatched.' );

$compat_options['wp_collab_cf_meta_box_suppression_enabled'] = false;
compat_reset_adapter_state();
$filtered = wp_collab_cf_filter_block_editor_meta_boxes( $memberpress_boxes );
compat_assert_true( isset( $filtered['post']['normal']['high']['mepr_unauthorized_message'] ), 'A disabled site policy must preserve MemberPress.' );
compat_assert_same( 'site_disabled', wp_collab_cf_get_compatibility_adapter_diagnostics()['memberpress']['reason'], 'Disabled MemberPress policy state was not reported.' );
$compat_options['wp_collab_cf_meta_box_suppression_enabled'] = true;

$compat_current_user_can_activate_plugins = false;
compat_reset_adapter_state();
$filtered = wp_collab_cf_filter_block_editor_meta_boxes( $memberpress_boxes );
compat_assert_same( false, isset( $filtered['post']['normal']['high']['mepr_unauthorized_message'] ), 'Non-administrators must receive the same site-wide MemberPress policy.' );
$compat_current_user_can_activate_plugins = true;

$compat_policy_ids = array( 'wpseo_meta' );
$compat_scripts = new Compat_Dependencies();
foreach ( wp_collab_cf_yoast_denied_script_handles() as $handle ) {
	$compat_scripts->add( $handle );
}
$compat_scripts->add( 'wp-seo-premium-redirect-notifications-gutenberg' );
$compat_scripts->add( 'wp-seo-premium-dynamic-blocks' );
$compat_scripts->add( 'wp-seo-local-frontend' );
$compat_scripts->add( 'wp-seo-local-blocks', array( 'wp-seo-local-frontend' ) );
$compat_scripts->add( 'yoast-seo-how-to-block' );
$compat_styles = new Compat_Dependencies();
foreach ( wp_collab_cf_yoast_denied_style_handles() as $handle ) {
	$compat_styles->add( $handle );
}
$compat_styles->add( 'preserved-editor-style' );
$compat_parse_blocks_calls = 0;

compat_reset_adapter_state();
compat_assert_same( false, wp_collab_cf_yoast_filter_editor_features( true ), 'The eligible owner filter must disable editor features.' );
compat_assert_same( false, wp_collab_cf_yoast_filter_premium_emoji_picker( true ), 'The eligible request must disable the Premium emoji picker.' );
wp_collab_cf_yoast_prune_editor_assets();
$compat_scripts->add( 'late-safe-entry' );
wp_collab_cf_yoast_prune_editor_assets();
$filtered = wp_collab_cf_filter_block_editor_meta_boxes( compat_registry( array() ) );
$yoast = wp_collab_cf_get_compatibility_adapter_diagnostics()['yoast'];
compat_assert_same( true, $yoast['ownerFilterObserved'], 'Owner-filter consultation must be recorded.' );
compat_assert_same( true, $yoast['eligible'], 'Yoast eligibility must be reported.' );
compat_assert_same( true, $yoast['applied'], 'Yoast application must be reported.' );
compat_assert_same( 'applied', $yoast['reason'], 'Yoast needs a stable applied reason.' );
compat_assert_same( true, wp_collab_cf_yoast_primary_category_editor_config()['enabled'], 'A fully applied post editor must receive the RTC-safe Primary Category bridge.' );
wp_collab_cf_yoast_prune_editor_assets();
$yoast_after_late_prune = wp_collab_cf_get_compatibility_adapter_diagnostics()['yoast'];
compat_assert_same( true, $yoast_after_late_prune['applied'], 'A later pruning seam must preserve a completed Yoast application.' );
compat_assert_same( 'applied', $yoast_after_late_prune['reason'], 'A later pruning seam must preserve the completed Yoast reason.' );
$compat_scripts->done[] = 'yoast-seo-post-edit';
wp_collab_cf_yoast_prune_editor_assets();
$yoast_after_late_failure = wp_collab_cf_get_compatibility_adapter_diagnostics()['yoast'];
compat_assert_same( false, $yoast_after_late_failure['applied'], 'A denied asset printed after finalization must revoke Yoast application.' );
compat_assert_same( 'asset_already_printed', $yoast_after_late_failure['reason'], 'A denied asset printed after finalization must remain terminal.' );
compat_assert_same( false, wp_collab_cf_yoast_primary_category_editor_config()['enabled'], 'A terminal adapter failure must disable the Primary Category bridge.' );
compat_assert_same( array(), array_values( array_intersect( wp_collab_cf_yoast_denied_script_handles(), $compat_scripts->queue ) ), 'Every denied script must leave the queue.' );
compat_assert_same( array(), array_values( array_intersect( wp_collab_cf_yoast_denied_script_handles(), $compat_scripts->to_do ) ), 'Every denied script must leave the pending print list.' );
compat_assert_same( array(), array_values( array_intersect( wp_collab_cf_yoast_denied_style_handles(), $compat_styles->queue ) ), 'Every paired editor-only style must leave the queue.' );
compat_assert_same( array(), array_values( array_intersect( wp_collab_cf_yoast_denied_style_handles(), $compat_styles->to_do ) ), 'Every paired editor-only style must leave the pending print list.' );
foreach ( array( 'wp-seo-premium-redirect-notifications-gutenberg', 'wp-seo-premium-dynamic-blocks', 'wp-seo-local-frontend', 'wp-seo-local-blocks', 'yoast-seo-how-to-block' ) as $preserved ) {
	compat_assert_true( in_array( $preserved, $compat_scripts->queue, true ), 'A preserved Yoast handle was removed: ' . $preserved );
}
compat_assert_true( in_array( 'wp-seo-video-seo', $yoast['removedScriptHandles'], true ), 'The Video metabox bundle must be pruned with its missing owner surface.' );
compat_assert_true( in_array( 'preserved-editor-style', $compat_styles->queue, true ), 'An unrelated style was removed.' );
compat_assert_same( 1, $compat_parse_blocks_calls, 'Stable Yoast content eligibility must be evaluated only once per request.' );
compat_assert_same( array( 'wpseo_meta' ), wp_collab_cf_get_meta_box_suppression_diagnostics()['matchedIds'], 'Owner-suppressed Yoast must count as matched without generic removal.' );

compat_reset_adapter_state();
$yoast_box = compat_registry( array( 'wpseo_meta' => compat_box( 'wpseo_meta', 'strlen' ) ) );
$filtered = wp_collab_cf_filter_block_editor_meta_boxes( $yoast_box );
compat_assert_true( isset( $filtered['post']['normal']['high']['wpseo_meta'] ), 'Yoast must never fall back to generic late removal.' );
compat_assert_same( false, wp_collab_cf_get_compatibility_adapter_diagnostics()['yoast']['ownerFilterObserved'], 'An unobserved owner filter must remain visible in diagnostics.' );
compat_reset_adapter_state();
$filtered = wp_collab_cf_filter_block_editor_meta_boxes( compat_registry( array() ) );
compat_assert_same( false, isset( $filtered['post']['normal']['high']['wp_collab_cf_yoast_compatibility_blocker'] ), 'An absent box plus unobserved owner filter means Yoast is inactive on this screen.' );
compat_assert_same( 'owner_filter_unobserved', wp_collab_cf_get_compatibility_adapter_diagnostics()['yoast']['reason'], 'Inactive Yoast needs an explicit unobserved-owner reason.' );

$compat_options['wp_collab_cf_meta_box_suppression_enabled'] = false;
compat_reset_adapter_state();
compat_assert_same( true, wp_collab_cf_yoast_filter_editor_features( true ), 'A disabled site policy must preserve the Yoast owner decision.' );
compat_assert_same( false, wp_collab_cf_yoast_primary_category_editor_config()['enabled'], 'The Primary Category bridge must stay off when the adapter is disabled.' );
compat_assert_same( false, call_user_func( $primary_category_meta['auth_callback'], true, WP_COLLAB_CF_YOAST_PRIMARY_CATEGORY_META_KEY, 42, 7 ), 'A disabled site policy must reject REST writes to primary category meta.' );
compat_assert_same( true, wp_collab_cf_yoast_filter_premium_emoji_picker( true ), 'A disabled site policy must preserve the Premium emoji picker.' );
$filtered = wp_collab_cf_filter_block_editor_meta_boxes( $yoast_box );
compat_assert_true( isset( $filtered['post']['normal']['high']['wpseo_meta'] ), 'A disabled site policy must preserve the Yoast box.' );
compat_assert_same( 'site_disabled', wp_collab_cf_get_compatibility_adapter_diagnostics()['yoast']['reason'], 'Disabled Yoast policy state was not reported.' );
$compat_options['wp_collab_cf_meta_box_suppression_enabled'] = true;

foreach ( array( 'direct-protected', 'direct-content-suggestion', 'nested-protected', 'synced-protected', 'synced-cycle', 'synced-missing', 'too-deep' ) as $protected_fixture ) {
	compat_reset_adapter_state();
	$post->post_content = $protected_fixture;
	compat_assert_same( true, wp_collab_cf_yoast_filter_editor_features( true ), 'Protected or uncertain content must keep Yoast enabled: ' . $protected_fixture );
	$filtered = wp_collab_cf_filter_block_editor_meta_boxes( compat_registry( array() ) );
	compat_assert_true(
		isset( $filtered['post']['normal']['high']['wp_collab_cf_yoast_compatibility_blocker'] ),
		'Protected or uncertain content must inject a safe incompatibility blocker when Yoast has no box: ' . $protected_fixture
	);
}
$post->post_content = 'safe';

compat_reset_adapter_state();
$compat_options['active_plugins'][] = 'wordpress-seo-news/wpseo-news.php';
$compat_scripts = new Compat_Dependencies();
compat_assert_true(
	in_array( 'wpseo-news-editor', wp_collab_cf_yoast_denied_script_handles(), true ),
	'The characterized News editor handle must remain in the denied graph.'
);
foreach ( wp_collab_cf_yoast_denied_script_handles() as $handle ) {
	$compat_scripts->add( $handle );
}
$compat_styles = new Compat_Dependencies();
foreach ( wp_collab_cf_yoast_denied_style_handles() as $handle ) {
	$compat_styles->add( $handle );
}
compat_assert_same( false, wp_collab_cf_yoast_filter_editor_features( true ), 'Supported Yoast News releases must use the Core owner suppression decision.' );
wp_collab_cf_yoast_prune_editor_assets();
$filtered = wp_collab_cf_filter_block_editor_meta_boxes( compat_registry( array() ) );
$news_diagnostics = wp_collab_cf_get_compatibility_adapter_diagnostics()['yoast'];
compat_assert_same( 'applied', $news_diagnostics['reason'], 'A newer Yoast News release should apply with supported Core and Premium versions.' );
compat_assert_same( '13.4', $news_diagnostics['newsVersion'], 'Yoast News diagnostics must report only the active version.' );
compat_assert_true( in_array( 'wpseo-news-editor', $news_diagnostics['removedScriptHandles'], true ), 'The News editor bundle must be pruned with its missing owner surface.' );
array_pop( $compat_options['active_plugins'] );

compat_reset_adapter_state();
$compat_options['active_plugins'][] = 'wordpress-seo-news/wpseo-news.php';
$compat_options['active_plugins'][] = 'custom-news/wpseo-news.php';
compat_assert_same( true, wp_collab_cf_yoast_filter_editor_features( true ), 'Multiple News main-file candidates must fail closed.' );
$filtered = wp_collab_cf_filter_block_editor_meta_boxes( compat_registry( array() ) );
$duplicate_news_diagnostics = wp_collab_cf_get_compatibility_adapter_diagnostics()['yoast'];
compat_assert_same( 'unsupported_addon', $duplicate_news_diagnostics['reason'], 'Multiple News candidates must be rejected as ambiguous.' );
compat_assert_true( isset( $filtered['post']['normal']['high']['wp_collab_cf_yoast_compatibility_blocker'] ), 'Ambiguous News candidates must keep Gutenberg exclusive.' );
array_pop( $compat_options['active_plugins'] );
array_pop( $compat_options['active_plugins'] );

compat_reset_adapter_state();
$compat_scripts = new Compat_Dependencies();
foreach ( wp_collab_cf_yoast_denied_script_handles() as $handle ) {
	$compat_scripts->add( $handle );
}
compat_assert_same( false, wp_collab_cf_yoast_filter_editor_features( true ), 'The owner filter should apply before late dependency drift.' );
$compat_scripts->add( 'unexpected-late-entry', array( 'yoast-seo-post-edit' ) );
wp_collab_cf_yoast_prune_editor_assets();
$filtered = wp_collab_cf_filter_block_editor_meta_boxes( compat_registry( array() ) );
$yoast = wp_collab_cf_get_compatibility_adapter_diagnostics()['yoast'];
compat_assert_same( 'unexpected_reverse_dependency', $yoast['reason'], 'Late reverse dependencies must fail closed.' );
compat_assert_true( isset( $filtered['post']['normal']['high']['wp_collab_cf_yoast_compatibility_blocker'] ), 'Late dependency drift must keep Gutenberg exclusive.' );
compat_assert_same( false, in_array( 'unexpected-late-entry', $compat_scripts->queue, true ), 'A reverse dependent must not load against removed Core DOM.' );

$private_dependency_handle = "unexpected/private\nhandle";
$compat_scripts = new Compat_Dependencies();
foreach ( wp_collab_cf_yoast_denied_script_handles() as $handle ) {
	$compat_scripts->add( $handle );
}
$compat_styles = new Compat_Dependencies();
compat_reset_adapter_state();
compat_assert_same( false, wp_collab_cf_yoast_filter_editor_features( true ), 'The owner filter should apply before an invalid-handle reverse dependency is registered.' );
$compat_scripts->add( $private_dependency_handle, array( 'yoast-seo-post-edit' ) );
wp_collab_cf_yoast_prune_editor_assets();
$filtered = wp_collab_cf_filter_block_editor_meta_boxes( compat_registry( array() ) );
$yoast = wp_collab_cf_get_compatibility_adapter_diagnostics()['yoast'];
compat_assert_same( false, in_array( $private_dependency_handle, $compat_scripts->queue, true ), 'Raw unexpected handles must be removed from the queue.' );
compat_assert_same( false, in_array( $private_dependency_handle, $compat_scripts->to_do, true ), 'Raw unexpected handles must be removed from the pending print list.' );
compat_assert_same( 1, $yoast['unexpectedDependencyCount'], 'Diagnostics should expose only the opaque dependency count.' );
compat_assert_same( false, array_key_exists( 'unexpectedDependencyHandles', $yoast ), 'Raw dependency handles must not enter server diagnostics.' );
compat_assert_same( false, false !== strpos( json_encode( $yoast ), $private_dependency_handle ), 'Invalid dependency handles must not be serialized.' );

$compat_scripts = new Compat_Dependencies();
foreach ( wp_collab_cf_yoast_denied_script_handles() as $handle ) {
	$compat_scripts->add( $handle );
}
$compat_scripts->done[] = 'yoast-seo-post-edit';
$compat_styles = new Compat_Dependencies();
compat_reset_adapter_state();
compat_assert_same( false, wp_collab_cf_yoast_filter_editor_features( true ), 'The owner filter may run before a printed-asset failure is observable.' );
wp_collab_cf_yoast_prune_editor_assets();
$refreshed_yoast = wp_collab_cf_yoast_refresh_request_diagnostics();
compat_assert_same( 'asset_already_printed', $refreshed_yoast['reason'], 'A printed denied asset must remain failed on an explicit refresh.' );
compat_assert_same( false, $refreshed_yoast['eligible'], 'A printed denied asset must remain ineligible on refresh.' );
$filtered = wp_collab_cf_filter_block_editor_meta_boxes( compat_registry( array() ) );
$yoast = wp_collab_cf_get_compatibility_adapter_diagnostics()['yoast'];
compat_assert_same( 'asset_already_printed', $yoast['reason'], 'A printed denied asset must remain a monotonic request failure through finalization.' );
compat_assert_same( false, $yoast['applied'], 'A printed denied asset must prevent adapter application.' );
compat_assert_true( isset( $filtered['post']['normal']['high']['wp_collab_cf_yoast_compatibility_blocker'] ), 'A printed denied asset must retain Gutenberg exclusivity.' );

$compat_scripts = new Compat_Dependencies();
foreach ( wp_collab_cf_yoast_denied_script_handles() as $handle ) {
	$compat_scripts->add( $handle );
}
$compat_styles = new Compat_Dependencies();
compat_reset_adapter_state();
compat_assert_same( false, wp_collab_cf_yoast_filter_editor_features( true ), 'The owner filter should suppress before final registry verification.' );
wp_collab_cf_yoast_prune_editor_assets();
$filtered = wp_collab_cf_filter_block_editor_meta_boxes( $yoast_box );
$yoast = wp_collab_cf_get_compatibility_adapter_diagnostics()['yoast'];
compat_assert_same( 'meta_box_still_registered', $yoast['reason'], 'Final success requires the real Yoast meta box to be absent.' );
compat_assert_same( false, $yoast['applied'], 'A lingering real Yoast box must prevent adapter application.' );
compat_assert_true( isset( $filtered['post']['normal']['high']['wpseo_meta'] ), 'The lingering real Yoast box must remain Gutenberg\'s compatibility blocker.' );
compat_assert_same( false, in_array( 'wpseo_meta', wp_collab_cf_get_meta_box_suppression_diagnostics()['matchedIds'], true ), 'A lingering real Yoast box must not be marked matched.' );

$compat_current_user_can_activate_plugins = false;
$compat_scripts = new Compat_Dependencies();
foreach ( wp_collab_cf_yoast_denied_script_handles() as $handle ) {
	$compat_scripts->add( $handle );
}
compat_reset_adapter_state();
compat_assert_same( false, wp_collab_cf_yoast_filter_editor_features( true ), 'Non-administrators must receive the same site-wide Yoast policy.' );
$compat_current_user_can_activate_plugins = true;

$serialized = json_encode( wp_collab_cf_get_compatibility_adapter_diagnostics(), JSON_UNESCAPED_SLASHES );
compat_assert_same( false, false !== strpos( $serialized, '/wordpress/' ), 'Compatibility diagnostics must not expose absolute paths.' );
compat_assert_same( false, false !== strpos( $serialized, 'yoast-news-seo.php' ), 'Compatibility diagnostics must not expose proprietary plugin basenames.' );
compat_assert_same( false, false !== strpos( $serialized, 'synced-protected' ), 'Compatibility diagnostics must not expose post content.' );

echo "Compatibility adapter PHP contract passed.\n";
