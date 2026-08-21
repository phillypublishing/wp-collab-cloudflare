<?php
/**
 * Shared compatibility version policy.
 *
 * @package WP_Collab_Cloudflare
 */

defined( 'ABSPATH' ) || exit;

/**
 * Return whether a plugin version is valid and meets a supported minimum.
 *
 * Compatibility adapters retain their structural safety checks while allowing
 * routine vendor updates beyond the release that was originally characterized.
 *
 * @param mixed  $version         Detected plugin version.
 * @param string $minimum_version Minimum supported plugin version.
 * @return bool Whether the detected version meets the minimum.
 */
function wp_collab_cf_version_meets_minimum( $version, $minimum_version ) {
	$version_pattern = '/^\d+(?:\.\d+)*(?:[-+][0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/D';

	return is_string( $version ) &&
		is_string( $minimum_version ) &&
		1 === preg_match( $version_pattern, $version ) &&
		1 === preg_match( $version_pattern, $minimum_version ) &&
		version_compare( $version, $minimum_version, '>=' );
}
