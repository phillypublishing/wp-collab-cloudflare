<?php

$mode = isset( $argv[1] ) ? $argv[1] : '';
if ( ! in_array( $mode, array( 'absent', 'mismatch', 'news-mismatch', 'news-missing' ), true ) ) {
	fwrite( STDERR, "Usage: php compatibility-version-policy.php absent|mismatch|news-mismatch|news-missing\n" );
	exit( 2 );
}

define( 'ABSPATH', '/wordpress/' );
define( 'WP_PLUGIN_DIR', '/wordpress/wp-content/plugins' );
define( 'WPMU_PLUGIN_DIR', '/wordpress/wp-content/mu-plugins' );
if ( 'mismatch' === $mode ) {
	define( 'WPSEO_VERSION', '28.2.1' );
	define( 'WPSEO_PREMIUM_VERSION', '28.3' );
	define( 'MEPR_VERSION', '1.12.18' );
} elseif ( 'news-mismatch' === $mode ) {
	define( 'WPSEO_VERSION', '28.2' );
	define( 'WPSEO_PREMIUM_VERSION', '28.2' );
	define( 'WPSEO_NEWS_VERSION', '13.4' );
	define( 'MEPR_VERSION', '1.12.17' );
} elseif ( 'news-missing' === $mode ) {
	define( 'WPSEO_VERSION', '28.2' );
	define( 'WPSEO_PREMIUM_VERSION', '28.2' );
	define( 'MEPR_VERSION', '1.12.17' );
}

$version_filters = array();
$version_scripts = (object) array(
	'registered' => array(),
	'queue' => array(),
	'to_do' => array(),
	'done' => array(),
);
$version_styles = clone $version_scripts;

function add_action() {}
function add_filter( $hook, $callback, $priority = 10, $accepted_args = 1 ) {
	global $version_filters;
	$version_filters[ $hook ][] = compact( 'callback', 'accepted_args' );
}
function apply_filters( $hook, $value, ...$args ) {
	global $version_filters;
	if ( 'wp_collab_cf_suppressed_meta_box_ids' === $hook ) {
		return array( 'mepr_unauthorized_message', 'wpseo_meta' );
	}
	if ( empty( $version_filters[ $hook ] ) ) {
		return $value;
	}
	foreach ( $version_filters[ $hook ] as $registration ) {
		$value = call_user_func_array(
			$registration['callback'],
			array_slice( array_merge( array( $value ), $args ), 0, $registration['accepted_args'] )
		);
	}
	return $value;
}
function get_option( $name, $default = false ) {
	global $mode;
	if ( 'wp_collab_cf_meta_box_suppression_enabled' === $name ) {
		return true;
	}
	if ( 'active_plugins' === $name && in_array( $mode, array( 'mismatch', 'news-mismatch', 'news-missing' ), true ) ) {
		$plugins = array( 'wordpress-seo/wp-seo.php', 'wordpress-seo-premium/wp-seo-premium.php' );
		if ( in_array( $mode, array( 'news-mismatch', 'news-missing' ), true ) ) {
			$plugins[] = 'wordpress-seo-news/wpseo-news.php';
		}
		return $plugins;
	}
	return $default;
}
function get_current_screen() {
	global $current_screen;
	return $current_screen;
}
function parse_blocks() {
	return array( array( 'blockName' => 'core/paragraph', 'attrs' => array(), 'innerBlocks' => array() ) );
}
function wp_scripts() {
	global $version_scripts;
	return $version_scripts;
}
function wp_styles() {
	global $version_styles;
	return $version_styles;
}
function current_user_can() { return false; }
function wp_strip_all_tags( $value ) { return strip_tags( $value ); }
function wp_normalize_path( $value ) { return str_replace( '\\', '/', $value ); }

class Version_Policy_Screen {
	public $id = 'post';
	public $post_type = 'post';
	public $base = 'post';
	public function is_block_editor() { return true; }
}

function version_policy_assert_same( $expected, $actual, $message ) {
	if ( $expected !== $actual ) {
		fwrite( STDERR, $message . "\nExpected: " . var_export( $expected, true ) . "\nActual: " . var_export( $actual, true ) . "\n" );
		exit( 1 );
	}
}

$current_screen = new Version_Policy_Screen();
$post = (object) array( 'ID' => 42, 'post_type' => 'post', 'post_content' => 'safe' );

require dirname( __DIR__ ) . '/wp-collab-cf.php';

if ( in_array( $mode, array( 'mismatch', 'news-mismatch', 'news-missing' ), true ) ) {
	wp_collab_cf_yoast_filter_editor_features( true );
}
$filtered = wp_collab_cf_filter_block_editor_meta_boxes( array() );
$diagnostics = wp_collab_cf_get_compatibility_adapter_diagnostics();
if ( ! in_array( $mode, array( 'news-mismatch', 'news-missing' ), true ) ) {
	version_policy_assert_same(
		'mismatch' === $mode ? 'version_mismatch' : 'plugin_absent',
		$diagnostics['memberpress']['reason'],
		'MemberPress did not fail closed for the version policy.'
	);
}
version_policy_assert_same(
	in_array( $mode, array( 'news-mismatch', 'news-missing' ), true )
		? 'unsupported_addon'
		: ( 'mismatch' === $mode ? 'version_mismatch' : 'plugin_absent' ),
	$diagnostics['yoast']['reason'],
	'Yoast did not fail closed for the version policy.'
);
if ( ! in_array( $mode, array( 'news-mismatch', 'news-missing' ), true ) ) {
	version_policy_assert_same( false, $diagnostics['memberpress']['applied'], 'MemberPress must not apply outside the exact version.' );
}
version_policy_assert_same( false, $diagnostics['yoast']['applied'], 'Yoast must not apply outside the exact version pair.' );
version_policy_assert_same(
	in_array( $mode, array( 'mismatch', 'news-mismatch', 'news-missing' ), true ),
	isset( $filtered['post']['normal']['high']['wp_collab_cf_yoast_compatibility_blocker'] ),
	'Only active version drift needs the synthetic Yoast blocker.'
);

echo "Compatibility {$mode} version policy passed.\n";
