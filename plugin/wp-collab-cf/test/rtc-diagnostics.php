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

function add_action() {}
function add_filter() {}
function wp_strip_all_tags( $value ) {
	return strip_tags( $value );
}
function wp_normalize_path( $value ) {
	return str_replace( '\\', '/', $value );
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
);

$report = wp_collab_cf_describe_meta_boxes( $boxes, 'post', false );
rtc_diagnostics_assert_same( 2, count( $report ), 'Expected only block-editor-visible meta boxes.' );
rtc_diagnostics_assert_same( true, $report[0]['rtcCompatible'], 'Compatible flag was lost.' );
rtc_diagnostics_assert_same( false, $report[1]['rtcCompatible'], 'Missing compatibility flag was not reported.' );
rtc_diagnostics_assert_same( 'Safe', $report[0]['title'], 'Meta box titles must be plain text.' );

echo "RTC diagnostics PHP contract passed.\n";
