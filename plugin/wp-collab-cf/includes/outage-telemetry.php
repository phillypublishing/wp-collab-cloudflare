<?php
/** Private, opt-in browser outage telemetry. Never accept arbitrary log context. */
defined( 'ABSPATH' ) || exit;

/** Return a canonical UUID, or null for anything else. */
function wp_collab_cf_telemetry_uuid( $value ) {
	$uuid = wp_collab_cf_bounded_log_identifier( $value, '/\A[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/i', 36 );
	return null !== $uuid ? strtolower( $uuid ) : null;
}

/** Extract only validated optional correlation fields, including on failures. */
function wp_collab_cf_telemetry_correlation( $context ) {
	$result = array();
	foreach ( array( 'editorSessionId', 'connectionAttemptId' ) as $field ) {
		$value = wp_collab_cf_telemetry_uuid( is_array( $context ) ? ( $context[ $field ] ?? null ) : null );
		if ( null !== $value ) {
			$result[ $field ] = $value;
		}
	}
	return $result;
}

/** Follow credential logging by default; permit an independent override. */
function wp_collab_cf_should_log_browser_outages() {
	$enabled = defined( 'WP_COLLAB_CF_LOG_BROWSER_OUTAGES' )
		? (bool) WP_COLLAB_CF_LOG_BROWSER_OUTAGES : wp_collab_cf_should_log_credential_requests();
	return (bool) apply_filters( 'wp_collab_cf_log_browser_outages', $enabled );
}

function wp_collab_cf_outage_error( $status = 400 ) {
	return new WP_Error( 'wp_collab_cf_invalid_outage_report', 'The outage report could not be accepted.', array( 'status' => $status ) );
}

/** Validate every known field and drop all unknown fields before logging. */
function wp_collab_cf_sanitize_outage_report( $body ) {
	if ( ! is_array( $body ) || ! wp_collab_cf_telemetry_uuid( $body['editorSessionId'] ?? null ) || ! is_int( $body['postId'] ?? null ) || $body['postId'] < 1 || $body['postId'] > 9007199254740991 ) {
		return wp_collab_cf_outage_error();
	}
	if ( ! is_array( $body['versions'] ?? null ) || ! is_array( $body['events'] ?? null ) || array_keys( $body['events'] ) !== range( 0, count( $body['events'] ) - 1 ) || count( $body['events'] ) < 1 || count( $body['events'] ) > 50 ) {
		return wp_collab_cf_outage_error();
	}
	$versions = array();
	$defaults = wp_collab_cf_telemetry_versions();
	foreach ( array( 'plugin', 'gutenberg', 'wordpress' ) as $field ) {
		$value = array_key_exists( $field, $body['versions'] ) ? $body['versions'][ $field ] : $defaults[ $field ];
		if ( null !== $value && ( ! is_string( $value ) || ! preg_match( '/\A[A-Za-z0-9.+_-]{1,64}\z/', $value ) ) ) {
			return wp_collab_cf_outage_error();
		}
		$versions[ $field ] = $value;
	}
	$allowed_events = array( 'credential_started', 'credential_succeeded', 'credential_failed', 'socket_closed', 'socket_error', 'socket_opened', 'sync_completed', 'outage_started', 'outage_threshold', 'outage_recovered', 'modal_shown', 'modal_hidden', 'visibility_changed', 'online', 'offline', 'provider_destroyed' );
	$integer_bounds = array(
		'seq' => array( 1, 9007199254740991 ), 'at' => array( 0, 8640000000000000 ),
		'elapsedMs' => array( 0, 604800000 ), 'durationMs' => array( 0, 604800000 ),
		'objectId' => array( 1, 9007199254740991 ), 'closeCode' => array( 0, 65535 ),
		'retryCount' => array( 0, 1000000 ), 'httpStatus' => array( 0, 599 ),
	);
	$events = array();
	foreach ( $body['events'] as $event ) {
		if ( ! is_array( $event ) || ! in_array( $event['event'] ?? null, $allowed_events, true ) || ! isset( $event['seq'], $event['at'], $event['elapsedMs'] ) ) {
			return wp_collab_cf_outage_error();
		}
		$clean = array( 'event' => $event['event'] );
		foreach ( $integer_bounds as $field => $bounds ) {
			if ( ! array_key_exists( $field, $event ) ) {
				continue;
			}
			$value = $event[ $field ];
			if ( 'objectId' === $field && null === $value ) {
				$clean[ $field ] = null;
				continue;
			}
			if ( ! is_int( $value ) || $value < $bounds[0] || $value > $bounds[1] ) {
				return wp_collab_cf_outage_error();
			}
			$clean[ $field ] = $value;
		}
		foreach ( array( 'outageId', 'connectionAttemptId' ) as $field ) {
			if ( array_key_exists( $field, $event ) ) {
				$clean[ $field ] = wp_collab_cf_telemetry_uuid( $event[ $field ] );
				if ( null === $clean[ $field ] ) {
					return wp_collab_cf_outage_error();
				}
			}
		}
		foreach ( array( 'online', 'synced' ) as $field ) {
			if ( array_key_exists( $field, $event ) ) {
				if ( ! is_bool( $event[ $field ] ) ) {
					return wp_collab_cf_outage_error();
				}
				$clean[ $field ] = $event[ $field ];
			}
		}
		foreach ( array( 'objectType' => '/\A[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\z/', 'errorCode' => '/\A[A-Za-z0-9_-]{1,64}\z/', 'visibility' => '/\A(?:visible|hidden)\z/' ) as $field => $pattern ) {
			if ( array_key_exists( $field, $event ) ) {
				if ( ! is_string( $event[ $field ] ) || strlen( $event[ $field ] ) > 128 || ! preg_match( $pattern, $event[ $field ] ) ) {
					return wp_collab_cf_outage_error();
				}
				$clean[ $field ] = $event[ $field ];
			}
		}
		$events[] = $clean;
	}
	usort( $events, function ( $left, $right ) { return $left['seq'] <=> $right['seq']; } );
	return array( 'editorSessionId' => wp_collab_cf_telemetry_uuid( $body['editorSessionId'] ), 'postId' => $body['postId'], 'versions' => $versions, 'events' => $events );
}

/**
 * Log bounded browser metadata. WP REST cookie auth checks X-WP-Nonce before
 * dispatch; check the authenticated user's story permission here as well.
 *
 * Transient rate limiting and deduplication are best effort, not an atomic lock.
 * A browser sends batches sequentially; a session high-water mark handles retries.
 */
function wp_collab_cf_rest_outage_report( WP_REST_Request $request ) {
	if ( ! is_user_logged_in() ) {
		return wp_collab_cf_outage_error( 401 );
	}
	if ( strlen( $request->get_body() ) > 49152 ) {
		return wp_collab_cf_outage_error( 413 );
	}
	$report = wp_collab_cf_sanitize_outage_report( $request->get_json_params() );
	if ( is_wp_error( $report ) ) {
		return $report;
	}
	if ( ! current_user_can( 'edit_post', $report['postId'] ) ) {
		return wp_collab_cf_outage_error( 403 );
	}
	$accepted = wp_collab_cf_should_log_browser_outages();
	if ( $accepted ) {
		$blog_id = (string) get_current_blog_id();
		$user_id = (string) get_current_user_id();
		$user_key = $blog_id . '_' . $user_id;
		$dedup_key = 'wp_collab_cf_outage_seq_' . $user_key . '_' . md5( $report['editorSessionId'] );
		$high_water = (int) get_transient( $dedup_key );
		$events = array_values( array_filter( $report['events'], function ( $event ) use ( $high_water ) { return $event['seq'] > $high_water; } ) );
		if ( count( $events ) > 0 ) {
			$rate_key = 'wp_collab_cf_outage_rate_' . $user_key;
			$rate = get_transient( $rate_key );
			$now = time();
			if ( ! is_array( $rate ) || $rate['until'] <= $now ) {
				$rate = array( 'count' => 0, 'until' => $now + 60 );
			}
			if ( $rate['count'] >= 10 ) {
				return wp_collab_cf_outage_error( 429 );
			}
			$rate['count']++;
			set_transient( $rate_key, $rate, max( 1, $rate['until'] - $now ) );
			$record = array(
				'schema' => 'wp-collab-cf-outage/v1', 'source' => 'browser',
				'siteId' => defined( 'WP_COLLAB_CF_SITE_ID' ) ? wp_collab_cf_bounded_log_identifier( WP_COLLAB_CF_SITE_ID, '/\A[A-Za-z0-9_-]+\z/', 64 ) : null,
				'blogId' => $blog_id, 'userId' => $user_id,
				'editorSessionId' => $report['editorSessionId'], 'postId' => $report['postId'], 'versions' => $report['versions'],
			);
			foreach ( $events as $event ) {
				if ( $event['seq'] <= $high_water ) {
					continue;
				}
				$record['receivedAt'] = (int) round( microtime( true ) * 1000 );
				$json = wp_json_encode( array_merge( $record, $event ), JSON_UNESCAPED_SLASHES );
				if ( false !== $json ) {
					error_log( '[wp-collab-cf] ' . $json );
				}
				$high_water = $event['seq'];
			}
			set_transient( $dedup_key, $high_water, 3600 );
		}
	}
	$response = rest_ensure_response( array( 'accepted' => $accepted ) );
	$response->header( 'Cache-Control', 'no-store' );
	return $response;
}

/** Provide an upload URL only when the private logging sink is enabled. */
function wp_collab_cf_browser_telemetry_config( $configured ) {
	if ( ! $configured || ! wp_collab_cf_should_log_browser_outages() ) {
		return array();
	}
	return array(
		'outageTelemetryUrl' => rest_url( 'wp-collab-cf/v1/outage-report' ),
		'versions' => wp_collab_cf_telemetry_versions(),
	);
}

/** Versions at editor load; reports preserve supplied versions from older tabs. */
function wp_collab_cf_telemetry_versions() {
	global $wp_version;
	return array(
		'plugin' => WP_COLLAB_CF_VERSION,
		'gutenberg' => defined( 'GUTENBERG_VERSION' ) ? (string) GUTENBERG_VERSION : null,
		'wordpress' => is_string( $wp_version ) ? $wp_version : null,
	);
}
