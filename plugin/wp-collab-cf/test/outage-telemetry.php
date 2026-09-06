<?php
// Standalone contract tests; no WordPress installation or running service required.
define( 'ABSPATH', '/wordpress/' );
define( 'WP_COLLAB_CF_SITE_ID', 'test_site_1234567890' );
define( 'WP_COLLAB_CF_WS_URL', 'wss://relay.test' );
define( 'WP_COLLAB_CF_AUTH_SECRET', str_repeat( 's', 40 ) );
error_reporting( E_ALL );
set_error_handler( function ( $severity, $message, $file, $line ) { throw new ErrorException( $message, 0, $severity, $file, $line ); } );
$enabled = true;
$credential_enabled = false;
$user_id = 103;
$can_edit = true;
$transients = array();
$routes = array();
function add_action( ...$args ) {}
function add_filter( ...$args ) {}
function apply_filters( $hook, $value, ...$args ) { global $enabled, $credential_enabled;
	if ( 'wp_collab_cf_log_browser_outages' === $hook && null !== $enabled ) { return $enabled; }
	if ( 'wp_collab_cf_log_credential_requests' === $hook ) { return $credential_enabled; }
	return $value; }
function is_user_logged_in() { return get_current_user_id() > 0; }
function get_current_user_id() { global $user_id; return $user_id; }
function get_current_blog_id() { return 3; }
function current_user_can( $capability, $id = null ) { global $can_edit; return $can_edit && 'edit_post' === $capability && 302085 === $id; }
function get_post( $id ) { return (object) array( 'ID' => $id, 'post_type' => 'post' ); }
function admin_url( $path ) { return 'https://example.test/wp-admin/' . $path; }
function wp_parse_url( ...$args ) { return parse_url( ...$args ); }
function rest_url( $path ) { return 'https://example.test/wp-json/' . $path; }
function wp_json_encode( $data, $flags = 0 ) { return json_encode( $data, $flags ); }
function is_wp_error( $value ) { return $value instanceof WP_Error; }
function rest_ensure_response( $data ) { return new WP_REST_Response( $data ); }
function get_transient( $key ) { global $transients; return $transients[ $key ] ?? false; }
function set_transient( $key, $value, $expiration ) { global $transients; $transients[ $key ] = $value; return true; }
function register_rest_route( $namespace, $route, $args ) { global $routes; $routes[ $route ] = $args; }
class WP_REST_Server { const CREATABLE = 'POST'; }
class WP_Error {
	public function __construct( private $code, private $message, private $data = null ) {}
	public function get_error_code() { return $this->code; }
	public function get_error_data() { return $this->data; }
}
class WP_REST_Request {
	public $parsed = false;
	public function __construct( private $json, private $raw = null ) {}
	public function get_body() { return $this->raw ?? json_encode( $this->json ); }
	public function get_json_params() { $this->parsed = true; return $this->json; }
	public function get_param( $name ) { return $this->json[ $name ] ?? null; }
}
class WP_REST_Response {
	public $headers = array();
	public function __construct( public $data ) {}
	public function header( $name, $value ) { $this->headers[ $name ] = $value; }
}
function check( $condition, $message ) { if ( ! $condition ) { throw new RuntimeException( $message ); } }
function status( $response ) { return $response instanceof WP_Error ? $response->get_error_data()['status'] : 200; }
if ( in_array( '--constant-disabled', $argv, true ) ) { define( 'WP_COLLAB_CF_LOG_BROWSER_OUTAGES', false ); }
require __DIR__ . '/../wp-collab-cf.php';
$enabled = null;
check( false === wp_collab_cf_should_log_browser_outages(), 'Browser logs default off with credential logs.' );
$credential_enabled = true;
if ( defined( 'WP_COLLAB_CF_LOG_BROWSER_OUTAGES' ) ) {
	check( false === wp_collab_cf_should_log_browser_outages(), 'Dedicated constant overrides enabled credential logging.' );
	echo "Outage logging constant override passed.\n";
	exit( 0 );
}
check( true === wp_collab_cf_should_log_browser_outages(), 'Browser logs follow enabled credential logs.' );
$enabled = false;
check( array() === wp_collab_cf_browser_telemetry_config( true ), 'Disabled logging must not expose an upload URL.' );
$enabled = true;
check( array() === wp_collab_cf_browser_telemetry_config( false ), 'Unconfigured sites must not expose an upload URL.' );
check( isset( wp_collab_cf_browser_telemetry_config( true )['outageTelemetryUrl'] ), 'Enabled configured sites must expose the upload URL.' );
$credential_enabled = false;
$log_path = tempnam( sys_get_temp_dir(), 'outage-test-' );
$previous_log = ini_get( 'error_log' );
ini_set( 'error_log', $log_path );
try {
	$session = '01234567-89ab-4def-8123-456789abcdef';
	$attempt = '11234567-89ab-4def-8123-456789abcdef';
	$event = array( 'event' => 'socket_closed', 'seq' => 1, 'at' => 1788712247000, 'elapsedMs' => 42, 'objectType' => 'postType/wp_block', 'objectId' => 248365, 'connectionAttemptId' => $attempt, 'closeCode' => 1006, 'online' => true, 'visibility' => 'visible' );
	$body = array( 'editorSessionId' => $session, 'postId' => 302085, 'versions' => array( 'plugin' => '0.5.13', 'gutenberg' => null, 'wordpress' => '7.0-alpha' ), 'events' => array( $event ) );
	$missing_version = $body;
	unset( $missing_version['versions']['plugin'] );
	check( WP_COLLAB_CF_VERSION === wp_collab_cf_sanitize_outage_report( $missing_version )['versions']['plugin'], 'Missing browser versions may fall back to server versions.' );
	$old_version = $body; $old_version['versions']['plugin'] = '0.5.12';
	check( '0.5.12' === wp_collab_cf_sanitize_outage_report( $old_version )['versions']['plugin'], 'Older open tabs must retain their actual plugin version.' );
	wp_collab_cf_register_rest_routes();
	check( isset( $routes['/outage-report'] ), 'Outage route must be registered.' );
	$user_id = 0;
	check( false === call_user_func( $routes['/outage-report']['permission_callback'] ), 'Anonymous REST access must be denied.' );
	check( 401 === status( wp_collab_cf_rest_outage_report( new WP_REST_Request( $body ) ) ), 'Callback must reject anonymous callers.' );
	$user_id = 103;
	$can_edit = false;
	check( 403 === status( wp_collab_cf_rest_outage_report( new WP_REST_Request( $body ) ) ), 'Cannot log reports for inaccessible posts.' );
	$can_edit = true;
	$oversized = new WP_REST_Request( $body, str_repeat( 'x', 49153 ) );
	check( 413 === status( wp_collab_cf_rest_outage_report( $oversized ) ) && ! $oversized->parsed, 'Reject oversized body before the callback accesses JSON parameters.' );
	$invalids = array();
	foreach ( array( 'seq' => '1', 'at' => INF, 'elapsedMs' => -1, 'objectType' => "postType/post\nsecret", 'objectId' => '2', 'connectionAttemptId' => 'bad', 'closeCode' => 65536, 'retryCount' => -1, 'durationMs' => 604800001, 'httpStatus' => 999, 'errorCode' => str_repeat( 'x', 65 ), 'online' => 1, 'visibility' => 'prerender', 'synced' => 'true', 'event' => 'story_content' ) as $key => $value ) {
		$invalid = $body; $invalid['events'][0][ $key ] = $value; $invalids[] = $invalid;
	}
	$invalid = $body; $invalid['events'] = array_fill( 0, 51, $event ); $invalids[] = $invalid;
	$invalid = $body; $invalid['editorSessionId'] = 'bad'; $invalids[] = $invalid;
	$invalid = $body; $invalid['versions']['plugin'] = str_repeat( 'p', 65 ); $invalids[] = $invalid;
	foreach ( $invalids as $invalid ) { check( 400 === status( wp_collab_cf_rest_outage_report( new WP_REST_Request( $invalid, '{}' ) ) ), 'Malformed telemetry must be rejected.' ); }
	check( '' === file_get_contents( $log_path ), 'Invalid/unauthorized reports must not be logged.' );
	$enabled = false;
	check( false === wp_collab_cf_rest_outage_report( new WP_REST_Request( $body ) )->data['accepted'], 'Disabled logging must return an explicit nonlogging outcome.' );
	check( '' === file_get_contents( $log_path ) && array() === $transients, 'Disabled logging must not log or allocate rate/dedup state.' );
	$enabled = true;
	$private = $body;
	$private['userId'] = 999;
	$private['versions']['secret'] = 'must-not-be-logged';
	$private['events'][0]['reason'] = 'must-not-be-logged';
	$private['events'][0]['content'] = 'must-not-be-logged';
	$response = wp_collab_cf_rest_outage_report( new WP_REST_Request( $private ) );
	check( true === $response->data['accepted'] && 'no-store' === $response->headers['Cache-Control'], 'Accepted response must prohibit caching.' );
	$logs = file_get_contents( $log_path );
	check( str_contains( $logs, '"schema":"wp-collab-cf-outage/v1"' ) && str_contains( $logs, '"source":"browser"' ) && str_contains( $logs, '"userId":"103"' ), 'Trusted attribution and schema required.' );
	check( ! str_contains( $logs, 'must-not-be-logged' ) && ! str_contains( $logs, '999' ), 'Only allowlisted metadata may enter logs.' );
	wp_collab_cf_rest_outage_report( new WP_REST_Request( $body ) );
	check( $logs === file_get_contents( $log_path ), 'Retry must not produce duplicate event logs.' );
	$body['events'][0]['seq'] = 2;
	$body['events'][0]['objectId'] = null;
	check( 200 === status( wp_collab_cf_rest_outage_report( new WP_REST_Request( $body ) ) ), 'Collection object IDs may be null.' );
	for ( $i = 3; $i <= 10; $i++ ) { $body['events'][0]['seq'] = $i; wp_collab_cf_rest_outage_report( new WP_REST_Request( $body ) ); }
	$body['events'][0]['seq'] = 11;
	check( 429 === status( wp_collab_cf_rest_outage_report( new WP_REST_Request( $body ) ) ), 'Per-user report limit must bound log volume.' );
	$context = array( 'editorSessionId' => $session, 'connectionAttemptId' => $attempt );
	$credentials = wp_collab_cf_rest_issue_credentials( new WP_REST_Request( array_merge( $context, array( 'objectType' => 'postType/post', 'objectId' => 302085 ) ) ) );
	check( 200 === status( $credentials ), 'Credentials with valid correlation IDs must work.' );
	$claims = json_decode( base64_decode( strtr( explode( '.', $credentials->data['token'] )[0], '-_', '+/' ) ), true );
	check( $claims['editorSessionId'] === $session && $claims['connectionAttemptId'] === $attempt, 'Correlation must be inside signed claims.' );
	$legacy = wp_collab_cf_issue_credentials( 'postType/post', 302085 );
	$legacy_claims = json_decode( base64_decode( strtr( explode( '.', $legacy['token'] )[0], '-_', '+/' ) ), true );
	check( ! isset( $legacy_claims['editorSessionId'] ), 'Legacy credential clients remain compatible.' );
	$bad_context = array_merge( $context, array( 'connectionAttemptId' => 'token-secret', 'objectType' => 'postType/post', 'objectId' => 302085 ) );
	$credential_enabled = true;
	file_put_contents( $log_path, '' );
	check( 400 === status( wp_collab_cf_rest_issue_credentials( new WP_REST_Request( $bad_context ) ) ), 'Invalid credential correlation must be rejected.' );
	$failure_log = file_get_contents( $log_path );
	check( str_contains( $failure_log, $session ) && ! str_contains( $failure_log, 'token-secret' ) && str_contains( $failure_log, 'wp_collab_cf_invalid_correlation' ), 'Invalid correlation logs retain the safe session but never the invalid field.' );
	$failure_record = wp_collab_cf_build_credential_log_record( 'postType/post', 302085, new WP_Error( 'denied', 'private', array( 'status' => 403 ) ), 1, $context );
	check( $session === $failure_record['editorSessionId'] && $attempt === $failure_record['connectionAttemptId'], 'Credential failures retain correlation.' );
	echo "Outage telemetry contracts passed.\n";
} finally {
	ini_set( 'error_log', $previous_log );
	unlink( $log_path );
}

exec( escapeshellarg( PHP_BINARY ) . ' ' . escapeshellarg( __FILE__ ) . ' --constant-disabled', $override_output, $override_status );
check( 0 === $override_status, 'Dedicated constant override contract failed.' );
