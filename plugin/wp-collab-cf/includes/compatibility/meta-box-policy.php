<?php
/**
 * Compatibility policy router for vendor-owned meta boxes.
 *
 * @package WP_Collab_Cloudflare
 */

defined( 'ABSPATH' ) || exit;

/**
 * Route reserved vendor IDs to their isolated compatibility adapters.
 *
 * @param array  $wp_meta_boxes Meta box registry copy.
 * @param string $screen_id     Current screen identifier.
 * @param array  $configured_ids Exact configured suppression IDs.
 * @param bool   $enabled       Whether the site-wide policy is enabled.
 * @param bool   $policy_valid  Whether the complete policy is valid.
 * @return array Filtered boxes, handled/matched IDs, and adapter diagnostics.
 */
function wp_collab_cf_apply_compatibility_meta_box_policies( $wp_meta_boxes, $screen_id, $configured_ids, $enabled, $policy_valid ) {
	$handled_ids = array( 'mepr_unauthorized_message', 'wpseo_meta' );
	$matched_ids = array();
	$memberpress = wp_collab_cf_memberpress_filter_meta_boxes(
		$wp_meta_boxes,
		$screen_id,
		in_array( 'mepr_unauthorized_message', $configured_ids, true ),
		$enabled,
		$policy_valid
	);
	$wp_meta_boxes = $memberpress['boxes'];
	if ( $memberpress['matched'] ) {
		$matched_ids[] = 'mepr_unauthorized_message';
	}

	$yoast = wp_collab_cf_yoast_finalize_meta_boxes(
		$wp_meta_boxes,
		$screen_id,
		in_array( 'wpseo_meta', $configured_ids, true ),
		$enabled,
		$policy_valid
	);
	$wp_meta_boxes = $yoast['boxes'];
	if ( $yoast['matched'] ) {
		$matched_ids[] = 'wpseo_meta';
	}

	return array(
		'boxes'       => $wp_meta_boxes,
		'handledIds'  => $handled_ids,
		'matchedIds'  => $matched_ids,
		'diagnostics' => array(
			'memberpress' => $memberpress['diagnostics'],
			'yoast'       => $yoast['diagnostics'],
		),
	);
}
