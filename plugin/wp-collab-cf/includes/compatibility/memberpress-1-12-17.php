<?php
/**
 * MemberPress Scale 1.12.17 compatibility policy.
 *
 * @package WP_Collab_Cloudflare
 */

defined( 'ABSPATH' ) || exit;

/**
 * Return a sanitized default MemberPress adapter report.
 *
 * @param bool $configured Whether the vendor meta box ID is configured.
 * @return array Adapter diagnostics.
 */
function wp_collab_cf_memberpress_default_diagnostics( $configured = false ) {
	return array(
		'adapter'    => 'memberpress_scale_1_12_17',
		'configured' => (bool) $configured,
		'eligible'   => false,
		'applied'    => false,
		'reason'     => $configured ? 'not_evaluated' : 'not_configured',
		'version'    => defined( 'MEPR_VERSION' ) && is_string( MEPR_VERSION ) ? MEPR_VERSION : null,
	);
}

/**
 * Check the characterized MemberPress callback without invoking it.
 *
 * @param mixed $callback Registered meta box callback.
 * @return bool Whether the callback is exactly MeprAppCtrl::unauthorized_meta_box.
 */
function wp_collab_cf_memberpress_callback_matches( $callback ) {
	return is_string( $callback ) && 'MeprAppCtrl::unauthorized_meta_box' === $callback;
}

/**
 * Require the exact characterized MemberPress version.
 *
 * @param mixed $version MemberPress version.
 * @return bool Whether the version is exactly supported.
 */
function wp_collab_cf_memberpress_version_supported( $version ) {
	return is_string( $version ) && '1.12.17' === $version;
}

/**
 * Apply the exact-version MemberPress whole-box policy to a registry copy.
 *
 * @param array  $wp_meta_boxes Meta box registry copy.
 * @param string $screen_id     Current screen identifier.
 * @param bool   $configured    Whether the exact ID is configured.
 * @param bool   $enabled       Whether the site-wide policy is enabled.
 * @param bool   $policy_valid  Whether the complete configured policy is valid.
 * @return array Filtered registry, match flag, and sanitized diagnostics.
 */
function wp_collab_cf_memberpress_filter_meta_boxes( $wp_meta_boxes, $screen_id, $configured, $enabled, $policy_valid ) {
	$diagnostics = wp_collab_cf_memberpress_default_diagnostics( $configured );
	$result      = array(
		'boxes'       => $wp_meta_boxes,
		'matched'     => false,
		'diagnostics' => $diagnostics,
	);

	if ( ! $configured ) {
		return $result;
	}
	if ( ! $policy_valid ) {
		$result['diagnostics']['reason'] = 'malformed_policy';
		return $result;
	}
	if ( ! $enabled ) {
		$result['diagnostics']['reason'] = 'site_disabled';
		return $result;
	}
	if ( ! defined( 'MEPR_VERSION' ) || ! is_string( MEPR_VERSION ) ) {
		$result['diagnostics']['reason'] = 'plugin_absent';
		return $result;
	}
	if ( ! wp_collab_cf_memberpress_version_supported( MEPR_VERSION ) ) {
		$result['diagnostics']['reason'] = 'version_mismatch';
		return $result;
	}

	$locations = array();
	if ( isset( $wp_meta_boxes[ $screen_id ] ) && is_array( $wp_meta_boxes[ $screen_id ] ) ) {
		foreach ( $wp_meta_boxes[ $screen_id ] as $context => $priorities ) {
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
					if ( 'mepr_unauthorized_message' === $meta_box_id ) {
						$locations[] = array( $context, $priority, $registered_id, $meta_box );
					}
				}
			}
		}
	}

	if ( empty( $locations ) ) {
		$result['diagnostics']['reason'] = 'meta_box_absent';
		return $result;
	}

	foreach ( $locations as $location ) {
		$meta_box = $location[3];
		if (
			! is_array( $meta_box ) ||
			! array_key_exists( 'callback', $meta_box ) ||
			! wp_collab_cf_memberpress_callback_matches( $meta_box['callback'] )
		) {
			$result['diagnostics']['reason'] = 'callback_mismatch';
			return $result;
		}
	}

	$result['diagnostics']['eligible'] = true;
	foreach ( $locations as $location ) {
		unset( $result['boxes'][ $screen_id ][ $location[0] ][ $location[1] ][ $location[2] ] );
	}
	$result['matched']                    = true;
	$result['diagnostics']['applied']     = true;
	$result['diagnostics']['reason']      = 'applied';
	return $result;
}
