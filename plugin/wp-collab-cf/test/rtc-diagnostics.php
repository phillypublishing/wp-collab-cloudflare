<?php

define( 'ABSPATH', '/wordpress/' );
define( 'WP_PLUGIN_DIR', '/wordpress/wp-content/plugins' );
define( 'WPMU_PLUGIN_DIR', '/wordpress/wp-content/mu-plugins' );

error_reporting( E_ALL );
set_error_handler(
	function ( $severity, $message, $file, $line ) {
		throw new ErrorException( $message, 0, $severity, $file, $line );
	}
);

$rtc_registered_actions = array();
$rtc_registered_filters = array();
$rtc_suppression_filter_value = array();
$rtc_suppression_filter_args = null;
$rtc_options = array();
$rtc_registered_routes = array();
$rtc_current_user_can_manage_options = true;
$rtc_update_option_should_fail = false;

function add_action( $hook, $callback, $priority = 10, $accepted_args = 1 ) {
	global $rtc_registered_actions;
	$rtc_registered_actions[] = compact( 'hook', 'callback', 'priority', 'accepted_args' );
}
function add_filter( $hook, $callback, $priority = 10, $accepted_args = 1 ) {
	global $rtc_registered_filters;
	$rtc_registered_filters[] = compact( 'hook', 'callback', 'priority', 'accepted_args' );
}
function apply_filters( $hook, $value, ...$args ) {
	global $rtc_suppression_filter_value, $rtc_suppression_filter_args;
	if ( 'wp_collab_cf_suppressed_meta_box_ids' === $hook ) {
		$rtc_suppression_filter_args = $args;
		return $rtc_suppression_filter_value;
	}
	return $value;
}
function get_option( $name, $default = false ) {
	global $rtc_options;
	return array_key_exists( $name, $rtc_options ) ? $rtc_options[ $name ] : $default;
}
function current_user_can( $capability ) {
	global $rtc_current_user_can_manage_options;
	return 'manage_options' === $capability && $rtc_current_user_can_manage_options;
}
function update_option( $name, $value ) {
	global $rtc_options, $rtc_update_option_should_fail;
	if ( $rtc_update_option_should_fail ) {
		return false;
	}
	if ( array_key_exists( $name, $rtc_options ) && $rtc_options[ $name ] === $value ) {
		return false;
	}
	$rtc_options[ $name ] = $value;
	return true;
}
function register_rest_route( $namespace, $route, $args ) {
	global $rtc_registered_routes;
	$rtc_registered_routes[] = compact( 'namespace', 'route', 'args' );
}
function rest_ensure_response( $data ) {
	return new WP_REST_Response( $data );
}
function is_wp_error( $value ) {
	return $value instanceof WP_Error;
}
function wp_strip_all_tags( $value ) {
	return strip_tags( $value );
}
function wp_normalize_path( $value ) {
	return str_replace( '\\', '/', $value );
}

class WP_REST_Server {
	const CREATABLE = 'POST';
}

class WP_Error {
	private $code;
	private $message;
	private $data;

	public function __construct( $code, $message, $data = null ) {
		$this->code = $code;
		$this->message = $message;
		$this->data = $data;
	}

	public function get_error_code() {
		return $this->code;
	}

	public function get_error_data() {
		return $this->data;
	}
}

class WP_REST_Request {
	private $json;

	public function __construct( $json ) {
		$this->json = $json;
	}

	public function get_json_params() {
		return $this->json;
	}

	public function get_param( $name ) {
		return is_array( $this->json ) && array_key_exists( $name, $this->json ) ? $this->json[ $name ] : null;
	}
}

class WP_REST_Response {
	private $data;

	public function __construct( $data ) {
		$this->data = $data;
	}

	public function get_data() {
		return $this->data;
	}

	public function header() {}
}

require dirname( __DIR__ ) . '/wp-collab-cf.php';

function rtc_diagnostics_assert_same( $expected, $actual, $message ) {
	if ( $expected !== $actual ) {
		fwrite( STDERR, $message . "\n" );
		exit( 1 );
	}
}

class Rtc_Diagnostics_Named_Callback {
	public function render() {}

	public function __invoke() {}
}

rtc_diagnostics_assert_same(
	array(
		'ownerType' => 'plugin',
		'owner' => 'seo-plugin',
		'sourceFile' => 'seo-plugin/includes/metabox.php',
	),
	wp_collab_cf_source_owner_for_file( '/wordpress/wp-content/plugins/seo-plugin/includes/metabox.php' ),
	'Plugin callback source was not classified safely.'
);

rtc_diagnostics_assert_same(
	array(
		'ownerType' => 'wordpress-core',
		'owner' => 'wordpress-core',
		'sourceFile' => 'wp-admin/includes/meta-boxes.php',
	),
	wp_collab_cf_source_owner_for_file( '/wordpress/wp-admin/includes/meta-boxes.php' ),
	'Core callback source was not classified safely.'
);

$anonymous_callback = new class() {
	public function render() {}

	public function __invoke() {}
};
$anonymous_method = wp_collab_cf_describe_callback( array( $anonymous_callback, 'render' ) );
$anonymous_invoke = wp_collab_cf_describe_callback( $anonymous_callback );
rtc_diagnostics_assert_same(
	'anonymous-class::render',
	$anonymous_method['callback'],
	'Anonymous method callback labels must not include their defining path.'
);
rtc_diagnostics_assert_same(
	'anonymous-class::__invoke',
	$anonymous_invoke['callback'],
	'Anonymous invokable callback labels must not include their defining path.'
);
rtc_diagnostics_assert_same(
	false,
	false !== strpos( $anonymous_method['callback'], "\0" ) || false !== strpos( $anonymous_invoke['callback'], "\0" ),
	'Anonymous callback labels must not include NUL bytes.'
);
$anonymous_serialized = json_encode(
	array( $anonymous_method, $anonymous_invoke ),
	JSON_UNESCAPED_SLASHES
);
rtc_diagnostics_assert_same(
	false,
	false !== strpos( $anonymous_serialized, '\\u0000' ),
	'Serialized anonymous callback owner data must not include escaped NUL bytes.'
);
rtc_diagnostics_assert_same(
	false,
	false !== strpos( $anonymous_serialized, wp_normalize_path( __DIR__ ) ),
	'Serialized anonymous callback owner data must not include its fixture path.'
);

$named_callback = new Rtc_Diagnostics_Named_Callback();
rtc_diagnostics_assert_same(
	'Rtc_Diagnostics_Named_Callback::render',
	wp_collab_cf_describe_callback( array( $named_callback, 'render' ) )['callback'],
	'Named method callback labels must remain useful.'
);
rtc_diagnostics_assert_same(
	'Rtc_Diagnostics_Named_Callback::__invoke',
	wp_collab_cf_describe_callback( $named_callback )['callback'],
	'Named invokable callback labels must remain useful.'
);
rtc_diagnostics_assert_same(
	'strlen',
	wp_collab_cf_describe_callback( 'strlen' )['callback'],
	'Named function callback labels must remain useful.'
);

$boxes = array(
	'post' => array(
		'normal' => array(
			'high' => array(
				'safe-box' => array(
					'id' => 'safe-box',
					'title' => '<strong>Safe</strong>',
					'callback' => 'strlen',
					'args' => array( '__rtc_compatible_meta_box' => true ),
				),
				'unsafe-box' => array(
					'id' => 'unsafe-box',
					'title' => 'Unsafe',
					'callback' => 'strlen',
					'args' => array(),
				),
				'back-compat-box' => array(
					'id' => 'back-compat-box',
					'title' => 'Classic editor only',
					'callback' => 'strlen',
					'args' => array( '__back_compat_meta_box' => true ),
				),
			),
		),
	),
	'page' => array(
		'normal' => array(
			'high' => array(
				'unsafe-box' => array(
					'id' => 'unsafe-box',
					'title' => 'Different screen',
					'callback' => 'strlen',
					'args' => array(),
				),
			),
		),
	),
);

$report = wp_collab_cf_describe_meta_boxes( $boxes, 'post', false );
rtc_diagnostics_assert_same( 2, count( $report ), 'Expected only block-editor-visible meta boxes.' );
rtc_diagnostics_assert_same( true, $report[0]['rtcCompatible'], 'Compatible flag was lost.' );
rtc_diagnostics_assert_same( false, $report[1]['rtcCompatible'], 'Missing compatibility flag was not reported.' );
rtc_diagnostics_assert_same( 'Safe', $report[0]['title'], 'Meta box titles must be plain text.' );

$suppression_hook = array_values(
	array_filter(
		$rtc_registered_filters,
		function ( $registration ) {
			return 'filter_block_editor_meta_boxes' === $registration['hook']
				&& 'wp_collab_cf_filter_block_editor_meta_boxes' === $registration['callback'];
		}
	)
);
rtc_diagnostics_assert_same( 1, count( $suppression_hook ), 'The suppression filter must be registered once.' );
rtc_diagnostics_assert_same( 90, $suppression_hook[0]['priority'], 'Suppression must run before Gutenberg priority 100.' );

$current_screen = (object) array( 'id' => 'post' );
$post = (object) array( 'ID' => 42, 'post_type' => 'post' );
$rtc_options['wp_collab_cf_meta_box_suppression_enabled'] = '1';
$rtc_suppression_filter_value = array( 'unsafe-box', 'unsafe-box', 'sorted-box', 'missing-box' );
$suppression_boxes = array(
	'post' => array(
		'normal' => array(
			'high' => array(
				'unsafe-box' => array(
					'id' => 'unsafe-box',
					'title' => 'Unsafe',
					'callback' => 'strlen',
					'args' => array(),
				),
				'unsafe-box-extra' => array(
					'id' => 'unsafe-box-extra',
					'title' => 'Exact matching only',
					'callback' => 'strlen',
					'args' => array(),
				),
			),
			'sorted' => array(
				'sorted-box' => array(
					'id' => 'sorted-box',
					'title' => 'Sorted blocker',
					'callback' => 'strlen',
					'args' => array(),
				),
			),
		),
		'side' => array(
			'low' => array(
				'unsafe-box' => array(
					'id' => 'unsafe-box',
					'title' => 'Duplicate occurrence',
					'callback' => 'strlen',
					'args' => array(),
				),
			),
		),
	),
);
$suppression_boxes['page'] = $boxes['page'];
$original_suppression_boxes = $suppression_boxes;
$filtered_boxes = wp_collab_cf_filter_block_editor_meta_boxes( $suppression_boxes );

rtc_diagnostics_assert_same( $original_suppression_boxes, $suppression_boxes, 'Suppression must not mutate the input registry.' );
rtc_diagnostics_assert_same( false, isset( $filtered_boxes['post']['normal']['high']['unsafe-box'] ), 'Configured high-priority occurrence was not suppressed.' );
rtc_diagnostics_assert_same( false, isset( $filtered_boxes['post']['side']['low']['unsafe-box'] ), 'Every configured occurrence must be suppressed.' );
rtc_diagnostics_assert_same( false, isset( $filtered_boxes['post']['normal']['sorted']['sorted-box'] ), 'The sorted priority must be traversed.' );
rtc_diagnostics_assert_same( true, isset( $filtered_boxes['post']['normal']['high']['unsafe-box-extra'] ), 'Suppression IDs must match exactly.' );
rtc_diagnostics_assert_same( true, isset( $filtered_boxes['page']['normal']['high']['unsafe-box'] ), 'Suppression must not alter an unrelated screen registry.' );
rtc_diagnostics_assert_same( array( $current_screen, $post ), $rtc_suppression_filter_args, 'The suppression filter must receive WP_Screen and WP_Post.' );

$captured_boxes = wp_collab_cf_capture_meta_box_diagnostics( $filtered_boxes );
rtc_diagnostics_assert_same( $filtered_boxes, $captured_boxes, 'PHP_INT_MAX diagnostics must not change the filtered registry.' );
$suppression = wp_collab_cf_get_meta_box_suppression_diagnostics();
rtc_diagnostics_assert_same( array( 'unsafe-box', 'sorted-box', 'missing-box' ), $suppression['configuredIds'], 'Configured IDs must be deduplicated without transformation.' );
rtc_diagnostics_assert_same( true, $suppression['enabled'], 'The site policy option should be reported as enabled.' );
rtc_diagnostics_assert_same( true, $suppression['effective'], 'A valid enabled policy should be effective.' );
rtc_diagnostics_assert_same( array( 'unsafe-box', 'sorted-box' ), $suppression['matchedIds'], 'Matched IDs were not reported.' );
rtc_diagnostics_assert_same( array( 'unsafe-box', 'sorted-box' ), $suppression['suppressedIds'], 'Suppressed IDs were not reported.' );
rtc_diagnostics_assert_same( array( 'missing-box' ), $suppression['unmatchedIds'], 'Unmatched configured IDs were not reported.' );
rtc_diagnostics_assert_same( array( 'unsafe-box-extra' ), $suppression['remainingBlockerIds'], 'Remaining filtered blockers were not reported.' );
rtc_diagnostics_assert_same(
	array( 'unsafe-box', 'unsafe-box-extra', 'sorted-box', 'unsafe-box' ),
	array_column( $suppression['originalMetaBoxes'], 'id' ),
	'Original inventory must retain every occurrence before suppression.'
);
rtc_diagnostics_assert_same( null, $suppression['warning'], 'A valid policy must not emit a malformed-policy warning.' );

$rtc_current_user_can_manage_options = false;
$non_admin_filtered = wp_collab_cf_filter_block_editor_meta_boxes( $suppression_boxes );
rtc_diagnostics_assert_same( false, isset( $non_admin_filtered['post']['normal']['high']['unsafe-box'] ), 'The enabled site policy must apply to non-administrators.' );
$rtc_current_user_can_manage_options = true;

$rtc_suppression_filter_value = array( 'unsafe-box', '' );
$malformed_filtered = wp_collab_cf_filter_block_editor_meta_boxes( $suppression_boxes );
rtc_diagnostics_assert_same( $suppression_boxes, $malformed_filtered, 'A malformed policy must fail closed to no suppression.' );
$suppression = wp_collab_cf_get_meta_box_suppression_diagnostics();
rtc_diagnostics_assert_same( array(), $suppression['configuredIds'], 'Malformed configured IDs must be discarded.' );
rtc_diagnostics_assert_same( false, $suppression['effective'], 'Malformed configuration must not be effective.' );
rtc_diagnostics_assert_same( 'malformed_suppressed_meta_box_ids', $suppression['warning'], 'Malformed configuration must emit a diagnostic warning.' );

$rtc_options['wp_collab_cf_meta_box_suppression_enabled'] = '';
$rtc_suppression_filter_value = array( 'unsafe-box' );
$disabled_filtered = wp_collab_cf_filter_block_editor_meta_boxes( $suppression_boxes );
rtc_diagnostics_assert_same( $suppression_boxes, $disabled_filtered, 'The site policy must default to off.' );
$suppression = wp_collab_cf_get_meta_box_suppression_diagnostics();
rtc_diagnostics_assert_same( false, $suppression['enabled'], 'Disabled site policy state was not reported.' );
rtc_diagnostics_assert_same( false, $suppression['effective'], 'A disabled site policy must not be effective.' );

wp_collab_cf_register_rest_routes();
$suppression_routes = array_values(
	array_filter(
		$rtc_registered_routes,
		function ( $registration ) {
			return 'wp-collab-cf/v1' === $registration['namespace']
				&& '/meta-box-suppression' === $registration['route'];
		}
	)
);
rtc_diagnostics_assert_same( 1, count( $suppression_routes ), 'The site policy REST endpoint must be registered once.' );
rtc_diagnostics_assert_same( 'wp_collab_cf_rest_update_meta_box_suppression', $suppression_routes[0]['args']['callback'], 'The site policy REST callback was not registered.' );
rtc_diagnostics_assert_same( 'wp_collab_cf_can_manage_meta_box_suppression', $suppression_routes[0]['args']['permission_callback'], 'The site policy endpoint must be capability gated.' );
rtc_diagnostics_assert_same( WP_REST_Server::CREATABLE, $suppression_routes[0]['args']['methods'], 'The site policy endpoint must be POST only.' );

$rtc_current_user_can_manage_options = false;
rtc_diagnostics_assert_same( false, wp_collab_cf_can_manage_meta_box_suppression(), 'Non-administrators must not change the site policy.' );
$rtc_current_user_can_manage_options = true;
rtc_diagnostics_assert_same( true, wp_collab_cf_can_manage_meta_box_suppression(), 'Administrators must be allowed to change the site policy.' );

foreach ( array( 1, 0, '1', '0', null, array(), new stdClass() ) as $invalid_enabled ) {
	$invalid_response = wp_collab_cf_rest_update_meta_box_suppression(
		new WP_REST_Request( array( 'enabled' => $invalid_enabled ) )
	);
	rtc_diagnostics_assert_same( true, is_wp_error( $invalid_response ), 'The REST endpoint must reject non-boolean enabled values.' );
	rtc_diagnostics_assert_same( 'wp_collab_cf_invalid_suppression_setting', $invalid_response->get_error_code(), 'Invalid setting values need a stable REST error.' );
}

$targeted_response = wp_collab_cf_rest_update_meta_box_suppression(
	new WP_REST_Request( array( 'enabled' => true, 'blogId' => 2 ) )
);
rtc_diagnostics_assert_same( true, is_wp_error( $targeted_response ), 'The REST endpoint must reject blog targeting.' );

$enable_response = wp_collab_cf_rest_update_meta_box_suppression(
	new WP_REST_Request( array( 'enabled' => true ) )
);
rtc_diagnostics_assert_same( array( 'enabled' => true ), $enable_response->get_data(), 'The REST endpoint must return the saved site policy.' );
rtc_diagnostics_assert_same( true, $rtc_options['wp_collab_cf_meta_box_suppression_enabled'], 'The REST endpoint must update the current blog option only.' );

$disable_response = wp_collab_cf_rest_update_meta_box_suppression(
	new WP_REST_Request( array( 'enabled' => false ) )
);
rtc_diagnostics_assert_same( array( 'enabled' => false ), $disable_response->get_data(), 'The REST endpoint must accept exact false.' );
rtc_diagnostics_assert_same( false, $rtc_options['wp_collab_cf_meta_box_suppression_enabled'], 'The REST endpoint must persist exact false.' );

$rtc_update_option_should_fail = true;
$failed_write = wp_collab_cf_rest_update_meta_box_suppression(
	new WP_REST_Request( array( 'enabled' => true ) )
);
rtc_diagnostics_assert_same( true, is_wp_error( $failed_write ), 'A failed option write must not report success.' );
rtc_diagnostics_assert_same( 'wp_collab_cf_suppression_update_failed', $failed_write->get_error_code(), 'A failed option write needs a stable REST error.' );
$rtc_update_option_should_fail = false;

$already_disabled = wp_collab_cf_rest_update_meta_box_suppression(
	new WP_REST_Request( array( 'enabled' => false ) )
);
rtc_diagnostics_assert_same( array( 'enabled' => false ), $already_disabled->get_data(), 'An idempotent option write must report the current state.' );

echo "RTC diagnostics PHP contract passed.\n";
