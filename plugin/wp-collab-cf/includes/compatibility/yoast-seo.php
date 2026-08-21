<?php
/**
 * Yoast SEO Core + Premium compatibility policy.
 *
 * @package WP_Collab_Cloudflare
 */

defined( 'ABSPATH' ) || exit;

const WP_COLLAB_CF_YOAST_CORE_MINIMUM_VERSION    = '28.2';
const WP_COLLAB_CF_YOAST_PREMIUM_MINIMUM_VERSION = '28.2';
const WP_COLLAB_CF_YOAST_NEWS_MINIMUM_VERSION    = '13.3';

/**
 * Return the exact editor script entrypoints denied by this adapter.
 *
 * @return array Script handles.
 */
function wp_collab_cf_yoast_denied_script_handles() {
	return array(
		'yoast-seo-post-edit',
		'yoast-seo-block-editor',
		'yoast-seo-ai-generator',
		'yoast-seo-ai-content-planner',
		'yoast-seo-ai-consent',
		'yoast-seo-premium-metabox',
		'yoast-social-metadata-previews',
		'wp-seo-premium-custom-fields-plugin',
		'yoast-seo-premium-draft-js-plugins',
		'yoast-seo-premium-draft-js-plugins-external',
		'wp-seo-premium-blocks',
		'wp-seo-premium-ai-optimize',
		'wp-seo-premium-ai-blocks',
		'wpseo-news-editor',
	);
}

/**
 * Return the paired editor-only styles denied by this adapter.
 *
 * Shared UI, redirect, dynamic-block, FAQ, How-to, and breadcrumb styles are
 * deliberately not included.
 *
 * @return array Style handles.
 */
function wp_collab_cf_yoast_denied_style_handles() {
	return array(
		'yoast-seo-metabox-css',
		'yoast-seo-block-editor',
		'yoast-seo-ai-generator',
		'yoast-seo-premium-metabox',
		'yoast-seo-premium-draft-js-plugins',
		'yoast-seo-premium-ai-fix-assessments',
		'yoast-seo-premium-block-editor',
		'yoast-seo-premium-ai-summarize',
	);
}

/**
 * Return the block entrypoints that cannot be preserved without denied assets.
 *
 * @return array Block names.
 */
function wp_collab_cf_yoast_protected_block_names() {
	return array(
		'yoast-seo/related-links',
		'yoast-seo/table-of-contents',
		'yoast-seo/ai-summarize',
		'yoast-seo/content-suggestion',
	);
}

/**
 * Return a stable default Yoast adapter report.
 *
 * @param bool $configured Whether wpseo_meta is configured.
 * @return array Adapter diagnostics.
 */
function wp_collab_cf_yoast_default_diagnostics( $configured = false ) {
	return array(
		// Stable diagnostics/v1 discriminator; use policyId for new integrations.
		'adapter'                    => 'yoast_seo_core_premium_28_2',
		'policyId'                   => 'yoast_seo_core_premium',
		'versionPolicy'              => 'minimum',
		'minimumVersions'            => array(
			'core'    => WP_COLLAB_CF_YOAST_CORE_MINIMUM_VERSION,
			'premium' => WP_COLLAB_CF_YOAST_PREMIUM_MINIMUM_VERSION,
			'news'    => WP_COLLAB_CF_YOAST_NEWS_MINIMUM_VERSION,
		),
		'configured'                 => (bool) $configured,
		'eligible'                   => false,
		'applied'                    => false,
		'reason'                     => $configured ? 'not_evaluated' : 'not_configured',
		'coreVersion'                => defined( 'WPSEO_VERSION' ) && is_string( WPSEO_VERSION ) ? WPSEO_VERSION : null,
		'premiumVersion'             => defined( 'WPSEO_PREMIUM_VERSION' ) && is_string( WPSEO_PREMIUM_VERSION ) ? WPSEO_PREMIUM_VERSION : null,
		'newsVersion'                => null,
		'ownerFilterObserved'        => false,
		'ownerFilterSuppressed'      => false,
		'emojiPickerDisabled'        => false,
		'protectedContent'           => array(
			'state' => 'not_evaluated',
			'reason' => null,
			'block' => null,
		),
		'addonState'                 => 'not_evaluated',
		'unsupportedAddonCount'      => 0,
		'dependencyState'            => 'not_evaluated',
		'unexpectedDependencyCount'  => 0,
		'assetsPruned'               => false,
		'removedScriptHandles'       => array(),
		'removedStyleHandles'        => array(),
		'limitation'                 => 'premium_prominent_words_may_be_stale',
	);
}

/**
 * Return the current request's Yoast state.
 *
 * @return array Adapter diagnostics.
 */
function wp_collab_cf_yoast_get_request_diagnostics() {
	global $wp_collab_cf_compatibility_adapters;

	if (
		isset( $wp_collab_cf_compatibility_adapters['yoast'] ) &&
		is_array( $wp_collab_cf_compatibility_adapters['yoast'] )
	) {
		return $wp_collab_cf_compatibility_adapters['yoast'];
	}

	return wp_collab_cf_yoast_default_diagnostics();
}

/**
 * Store sanitized Yoast adapter state for the current request.
 *
 * @param array $diagnostics Adapter diagnostics.
 */
function wp_collab_cf_yoast_set_request_diagnostics( $diagnostics ) {
	global $wp_collab_cf_compatibility_adapters;

	if ( ! isset( $wp_collab_cf_compatibility_adapters ) || ! is_array( $wp_collab_cf_compatibility_adapters ) ) {
		$wp_collab_cf_compatibility_adapters = array();
	}
	$wp_collab_cf_compatibility_adapters['yoast'] = $diagnostics;
}

/**
 * Require the characterized Core and Premium versions or newer.
 *
 * @param mixed $core_version    Core version.
 * @param mixed $premium_version Premium version.
 * @return bool Whether both versions meet their supported minimums.
 */
function wp_collab_cf_yoast_versions_supported( $core_version, $premium_version ) {
	return wp_collab_cf_version_meets_minimum( $core_version, WP_COLLAB_CF_YOAST_CORE_MINIMUM_VERSION ) &&
		wp_collab_cf_version_meets_minimum( $premium_version, WP_COLLAB_CF_YOAST_PREMIUM_MINIMUM_VERSION );
}

/**
 * Require the characterized Yoast SEO: News version or newer.
 *
 * @param mixed $news_version News version.
 * @return bool Whether the version meets the supported minimum.
 */
function wp_collab_cf_yoast_news_version_supported( $news_version ) {
	return wp_collab_cf_version_meets_minimum( $news_version, WP_COLLAB_CF_YOAST_NEWS_MINIMUM_VERSION );
}

/**
 * Identify the Yoast SEO: News main plugin file without depending on its folder.
 *
 * @param mixed $plugin_basename Active plugin basename.
 * @return bool Whether this is the News main file.
 */
function wp_collab_cf_yoast_is_news_addon_basename( $plugin_basename ) {
	if ( ! is_string( $plugin_basename ) ) {
		return false;
	}
	$normalized = strtolower( str_replace( '\\', '/', $plugin_basename ) );
	return 'wpseo-news.php' === basename( $normalized );
}

/**
 * Find obvious active Yoast add-ons while keeping plugin basenames private.
 *
 * @param array $active_plugins Active plugin basenames.
 * @return array One opaque marker per unsupported add-on.
 */
function wp_collab_cf_yoast_find_unsupported_addons( $active_plugins ) {
	$allowed = array(
		'wordpress-seo/wp-seo.php',
		'wordpress-seo-premium/wp-seo-premium.php',
	);
	$unsupported = array();

	foreach ( (array) $active_plugins as $plugin_basename ) {
		if ( ! is_string( $plugin_basename ) || in_array( $plugin_basename, $allowed, true ) ) {
			continue;
		}
		if ( wp_collab_cf_yoast_is_news_addon_basename( $plugin_basename ) ) {
			continue;
		}
		$normalized = strtolower( str_replace( '\\', '/', $plugin_basename ) );
		if (
			false !== strpos( $normalized, 'yoast' ) ||
			false !== strpos( $normalized, 'wordpress-seo' ) ||
			false !== strpos( $normalized, 'wpseo' )
		) {
			$unsupported[] = 'unsupported';
		}
	}

	return $unsupported;
}

/**
 * Return all active plugin basenames without exposing them to diagnostics.
 *
 * @return array Active plugin basenames.
 */
function wp_collab_cf_yoast_active_plugin_basenames() {
	$active = get_option( 'active_plugins', array() );
	$active = is_array( $active ) ? $active : array();
	if ( function_exists( 'get_site_option' ) ) {
		$network_active = get_site_option( 'active_sitewide_plugins', array() );
		if ( is_array( $network_active ) ) {
			$active = array_merge( $active, array_keys( $network_active ) );
		}
	}

	return array_values( array_unique( $active ) );
}

/**
 * Inspect a post's full block graph, including synced pattern references.
 *
 * @param string $content Post content.
 * @return array Sanitized state, reason, and protected block name.
 */
function wp_collab_cf_yoast_inspect_post_content( $content ) {
	$budget = array(
		'blocks' => 0,
		'refs'   => 0,
	);
	$stack = array();

	if ( ! is_string( $content ) ) {
		return array( 'state' => 'uncertain', 'reason' => 'unreadable_content', 'block' => null );
	}

	return wp_collab_cf_yoast_inspect_block_content( $content, 0, $stack, $budget );
}

/**
 * Parse and inspect one content document.
 *
 * @param string $content Serialized block content.
 * @param int    $depth   Current recursion depth.
 * @param array  $stack   Active synced reference stack.
 * @param array  $budget  Shared traversal budget.
 * @return array Inspection result.
 */
function wp_collab_cf_yoast_inspect_block_content( $content, $depth, &$stack, &$budget ) {
	if ( $depth > 24 ) {
		return array( 'state' => 'uncertain', 'reason' => 'depth_limit', 'block' => null );
	}
	if ( ! function_exists( 'parse_blocks' ) ) {
		return array( 'state' => 'uncertain', 'reason' => 'parser_unavailable', 'block' => null );
	}

	try {
		$blocks = parse_blocks( $content );
	} catch ( Throwable $error ) {
		return array( 'state' => 'uncertain', 'reason' => 'parse_failed', 'block' => null );
	}
	if ( ! is_array( $blocks ) ) {
		return array( 'state' => 'uncertain', 'reason' => 'parse_failed', 'block' => null );
	}

	return wp_collab_cf_yoast_inspect_blocks( $blocks, $depth, $stack, $budget );
}

/**
 * Recursively inspect parsed blocks with cycle and work bounds.
 *
 * @param array $blocks Parsed blocks.
 * @param int   $depth  Current recursion depth.
 * @param array $stack  Active synced reference stack.
 * @param array $budget Shared traversal budget.
 * @return array Inspection result.
 */
function wp_collab_cf_yoast_inspect_blocks( $blocks, $depth, &$stack, &$budget ) {
	if ( $depth > 24 ) {
		return array( 'state' => 'uncertain', 'reason' => 'depth_limit', 'block' => null );
	}

	foreach ( $blocks as $block ) {
		++$budget['blocks'];
		if ( $budget['blocks'] > 1000 ) {
			return array( 'state' => 'uncertain', 'reason' => 'block_limit', 'block' => null );
		}
		if ( ! is_array( $block ) ) {
			return array( 'state' => 'uncertain', 'reason' => 'malformed_block', 'block' => null );
		}

		$block_name = isset( $block['blockName'] ) ? $block['blockName'] : null;
		if ( null !== $block_name && ! is_string( $block_name ) ) {
			return array( 'state' => 'uncertain', 'reason' => 'malformed_block', 'block' => null );
		}
		if ( in_array( $block_name, wp_collab_cf_yoast_protected_block_names(), true ) ) {
			return array( 'state' => 'protected', 'reason' => 'protected_block', 'block' => $block_name );
		}

		if ( 'core/block' === $block_name ) {
			$attrs = isset( $block['attrs'] ) && is_array( $block['attrs'] ) ? $block['attrs'] : array();
			$ref   = isset( $attrs['ref'] ) ? $attrs['ref'] : null;
			if ( ! is_int( $ref ) || $ref < 1 ) {
				return array( 'state' => 'uncertain', 'reason' => 'synced_ref_invalid', 'block' => null );
			}
			++$budget['refs'];
			if ( $budget['refs'] > 100 ) {
				return array( 'state' => 'uncertain', 'reason' => 'synced_ref_limit', 'block' => null );
			}
			if ( isset( $stack[ $ref ] ) ) {
				return array( 'state' => 'uncertain', 'reason' => 'synced_ref_cycle', 'block' => null );
			}
			try {
				$can_read_synced_post = current_user_can( 'read_post', $ref );
			} catch ( Throwable $error ) {
				$can_read_synced_post = false;
			}
			if ( ! $can_read_synced_post ) {
				return array( 'state' => 'uncertain', 'reason' => 'synced_ref_unavailable', 'block' => null );
			}

			try {
				$synced_post = get_post( $ref );
			} catch ( Throwable $error ) {
				$synced_post = null;
			}
			if (
				! is_object( $synced_post ) ||
				! isset( $synced_post->post_type ) ||
				'wp_block' !== $synced_post->post_type ||
				! isset( $synced_post->post_content ) ||
				! is_string( $synced_post->post_content )
			) {
				return array( 'state' => 'uncertain', 'reason' => 'synced_ref_unavailable', 'block' => null );
			}

			$stack[ $ref ] = true;
			$result = wp_collab_cf_yoast_inspect_block_content( $synced_post->post_content, $depth + 1, $stack, $budget );
			unset( $stack[ $ref ] );
			if ( 'safe' !== $result['state'] ) {
				return $result;
			}
		}

		$inner_blocks = isset( $block['innerBlocks'] ) ? $block['innerBlocks'] : array();
		if ( ! is_array( $inner_blocks ) ) {
			return array( 'state' => 'uncertain', 'reason' => 'malformed_block', 'block' => null );
		}
		if ( ! empty( $inner_blocks ) ) {
			$result = wp_collab_cf_yoast_inspect_blocks( $inner_blocks, $depth + 1, $stack, $budget );
			if ( 'safe' !== $result['state'] ) {
				return $result;
			}
		}
	}

	return array( 'state' => 'safe', 'reason' => null, 'block' => null );
}

/**
 * Return whether the current request is a singular block-editor post screen.
 *
 * @return bool Whether the adapter may run on this screen.
 */
function wp_collab_cf_yoast_is_block_editor_post_screen() {
	global $current_screen;

	$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : $current_screen;
	if ( ! is_object( $screen ) ) {
		return false;
	}
	if ( isset( $screen->base ) && 'post' !== $screen->base ) {
		return false;
	}
	if ( ! method_exists( $screen, 'is_block_editor' ) ) {
		return false;
	}

	try {
		return true === $screen->is_block_editor();
	} catch ( Throwable $error ) {
		return false;
	}
}

/**
 * Return the current request post type without trusting query parameters.
 *
 * @return string|null Post type.
 */
function wp_collab_cf_yoast_current_post_type() {
	global $current_screen, $post;

	if ( is_object( $post ) && isset( $post->post_type ) && is_string( $post->post_type ) ) {
		return $post->post_type;
	}
	if ( is_object( $current_screen ) && isset( $current_screen->post_type ) && is_string( $current_screen->post_type ) ) {
		return $current_screen->post_type;
	}

	return null;
}

/**
 * Determine whether a registered handle reaches any denied entrypoint.
 *
 * @param string $handle     Registered handle.
 * @param array  $registered Registered dependencies.
 * @param array  $denied_set Denied handle set.
 * @param array  $visiting   Traversal cycle guard.
 * @return bool Whether the handle depends on a denied entrypoint.
 */
function wp_collab_cf_yoast_dependency_reaches_denied( $handle, $registered, $denied_set, &$visiting ) {
	if ( isset( $denied_set[ $handle ] ) ) {
		return true;
	}
	if ( isset( $visiting[ $handle ] ) || ! isset( $registered[ $handle ] ) ) {
		return false;
	}

	$visiting[ $handle ] = true;
	$dependency          = $registered[ $handle ];
	$deps                = is_object( $dependency ) && isset( $dependency->deps ) && is_array( $dependency->deps )
		? $dependency->deps
		: array();
	foreach ( $deps as $dep ) {
		if (
			is_string( $dep ) &&
			wp_collab_cf_yoast_dependency_reaches_denied( $dep, $registered, $denied_set, $visiting )
		) {
			unset( $visiting[ $handle ] );
			return true;
		}
	}
	unset( $visiting[ $handle ] );

	return false;
}

/**
 * Find registered reverse dependencies outside the exact denied graph.
 *
 * @param object|null $scripts WordPress scripts registry.
 * The raw handles are request-internal pruning targets. They must never be
 * copied into diagnostics because plugin authors control handle strings.
 *
 * @return array Raw unexpected handles.
 */
function wp_collab_cf_yoast_find_unexpected_reverse_dependencies( $scripts = null ) {
	if ( null === $scripts && function_exists( 'wp_scripts' ) ) {
		$scripts = wp_scripts();
	}
	if ( ! is_object( $scripts ) || ! isset( $scripts->registered ) || ! is_array( $scripts->registered ) ) {
		return array();
	}

	$denied     = wp_collab_cf_yoast_denied_script_handles();
	$denied_set = array_fill_keys( $denied, true );
	$unexpected = array();
	foreach ( $scripts->registered as $handle => $dependency ) {
		if ( ! is_string( $handle ) || isset( $denied_set[ $handle ] ) ) {
			continue;
		}
		$visiting = array();
		if ( wp_collab_cf_yoast_dependency_reaches_denied( $handle, $scripts->registered, $denied_set, $visiting ) ) {
			$unexpected[] = $handle;
		}
	}

	sort( $unexpected, SORT_STRING );
	return array_values( array_unique( $unexpected ) );
}

/**
 * Evaluate all preconditions that can safely suppress the owner surface.
 *
 * @return array Sanitized adapter diagnostics.
 */
function wp_collab_cf_yoast_evaluate_stable_request() {
	global $post;

	if ( ! wp_collab_cf_yoast_is_block_editor_post_screen() || ! wp_collab_cf_yoast_current_post_type() ) {
		$diagnostics           = wp_collab_cf_yoast_default_diagnostics();
		$diagnostics['reason'] = 'not_block_editor_post_screen';
		return $diagnostics;
	}

	$policy      = wp_collab_cf_get_suppressed_meta_box_ids();
	$configured  = in_array( 'wpseo_meta', $policy['ids'], true );
	$diagnostics = wp_collab_cf_yoast_default_diagnostics( $configured );

	if ( ! $configured ) {
		return $diagnostics;
	}
	if ( null !== $policy['warning'] ) {
		$diagnostics['reason'] = 'malformed_policy';
		return $diagnostics;
	}
	if ( ! wp_collab_cf_is_meta_box_suppression_enabled() ) {
		$diagnostics['reason'] = 'site_disabled';
		return $diagnostics;
	}
	if ( ! defined( 'WPSEO_VERSION' ) || ! defined( 'WPSEO_PREMIUM_VERSION' ) ) {
		$diagnostics['reason'] = 'plugin_absent';
		return $diagnostics;
	}
	if ( ! wp_collab_cf_yoast_versions_supported( WPSEO_VERSION, WPSEO_PREMIUM_VERSION ) ) {
		$diagnostics['reason'] = 'version_mismatch';
		return $diagnostics;
	}

	$active_plugins      = wp_collab_cf_yoast_active_plugin_basenames();
	$unsupported_addons  = wp_collab_cf_yoast_find_unsupported_addons( $active_plugins );
	$news_active         = defined( 'WPSEO_NEWS_VERSION' );
	$news_basename_count = 0;
	foreach ( $active_plugins as $plugin_basename ) {
		if ( wp_collab_cf_yoast_is_news_addon_basename( $plugin_basename ) ) {
			$news_active = true;
			++$news_basename_count;
		}
	}
	if ( $news_active ) {
		$diagnostics['newsVersion'] = defined( 'WPSEO_NEWS_VERSION' ) && is_string( WPSEO_NEWS_VERSION )
			? WPSEO_NEWS_VERSION
			: null;
		if ( ! wp_collab_cf_yoast_news_version_supported( $diagnostics['newsVersion'] ) ) {
			$unsupported_addons[] = 'unsupported';
		}
		if ( $news_basename_count > 1 ) {
			$unsupported_addons[] = 'unsupported';
		}
	}
	$diagnostics['unsupportedAddonCount'] = count( $unsupported_addons );
	$diagnostics['addonState']            = empty( $unsupported_addons ) ? 'supported' : 'unsupported';
	if ( ! empty( $unsupported_addons ) ) {
		$diagnostics['reason'] = 'unsupported_addon';
		return $diagnostics;
	}

	$content = is_object( $post ) && isset( $post->post_content ) ? $post->post_content : null;
	$diagnostics['protectedContent'] = wp_collab_cf_yoast_inspect_post_content( $content );
	if ( 'safe' !== $diagnostics['protectedContent']['state'] ) {
		$diagnostics['reason'] = 'protected' === $diagnostics['protectedContent']['state']
			? 'protected_content'
			: 'protected_content_uncertain';
		return $diagnostics;
	}

	$diagnostics['eligible'] = true;
	$diagnostics['reason']   = 'eligible';
	return $diagnostics;
}

/**
 * Return request-stable policy, version, add-on, and content eligibility.
 *
 * The post and plugin configuration cannot change during one editor request.
 * Dependency queues are deliberately excluded because late enqueues must be
 * checked again at every pruning seam.
 *
 * @return array Stable request diagnostics.
 */
function wp_collab_cf_yoast_get_stable_request_diagnostics() {
	global $wp_collab_cf_yoast_stable_request_diagnostics;

	if ( ! wp_collab_cf_yoast_is_block_editor_post_screen() || ! wp_collab_cf_yoast_current_post_type() ) {
		$diagnostics           = wp_collab_cf_yoast_default_diagnostics();
		$diagnostics['reason'] = 'not_block_editor_post_screen';
		return $diagnostics;
	}

	if ( isset( $wp_collab_cf_yoast_stable_request_diagnostics ) && is_array( $wp_collab_cf_yoast_stable_request_diagnostics ) ) {
		return $wp_collab_cf_yoast_stable_request_diagnostics;
	}

	$wp_collab_cf_yoast_stable_request_diagnostics = wp_collab_cf_yoast_evaluate_stable_request();
	return $wp_collab_cf_yoast_stable_request_diagnostics;
}

/**
 * Re-evaluate request inputs while preserving observations and removals.
 *
 * @return array Current state.
 */
function wp_collab_cf_yoast_refresh_request_diagnostics() {
	global $wp_collab_cf_yoast_unexpected_dependency_handles;

	$previous = wp_collab_cf_yoast_get_request_diagnostics();
	$current  = wp_collab_cf_yoast_get_stable_request_diagnostics();
	foreach (
		array(
			'ownerFilterObserved',
			'ownerFilterSuppressed',
			'emojiPickerDisabled',
			'assetsPruned',
			'removedScriptHandles',
			'removedStyleHandles',
		) as $preserved_key
	) {
		if ( isset( $previous[ $preserved_key ] ) ) {
			$current[ $preserved_key ] = $previous[ $preserved_key ];
		}
	}

	if ( $current['eligible'] ) {
		$unexpected = wp_collab_cf_yoast_find_unexpected_reverse_dependencies();
		$wp_collab_cf_yoast_unexpected_dependency_handles = $unexpected;
		$current['unexpectedDependencyCount'] = count( $unexpected );
		$current['dependencyState']           = empty( $unexpected ) ? 'supported' : 'unexpected';
		if ( ! empty( $unexpected ) ) {
			$current['eligible'] = false;
			$current['reason']   = 'unexpected_reverse_dependency';
		}
	} else {
		$wp_collab_cf_yoast_unexpected_dependency_handles = array();
	}

	$terminal_reasons = array(
		'asset_already_printed',
		'asset_pruning_unobserved',
		'meta_box_still_registered',
		'owner_filter_not_suppressed',
		'owner_filter_unobserved',
	);
	if ( in_array( $previous['reason'], $terminal_reasons, true ) ) {
		$current['eligible'] = false;
		$current['applied']  = false;
		$current['reason']   = $previous['reason'];
	} elseif ( $current['eligible'] && ! empty( $previous['applied'] ) ) {
		$current['applied'] = true;
		$current['reason']  = 'applied';
	}
	wp_collab_cf_yoast_set_request_diagnostics( $current );
	return $current;
}

/**
 * Owner-supported dynamic post-type filter callback.
 *
 * @param bool $enabled Yoast's editor feature decision.
 * @return bool Filtered decision.
 */
function wp_collab_cf_yoast_filter_editor_features( $enabled ) {
	$diagnostics = wp_collab_cf_yoast_refresh_request_diagnostics();
	$diagnostics['ownerFilterObserved'] = true;
	if ( $diagnostics['eligible'] ) {
		$diagnostics['ownerFilterSuppressed'] = true;
		wp_collab_cf_yoast_set_request_diagnostics( $diagnostics );
		return false;
	}

	wp_collab_cf_yoast_set_request_diagnostics( $diagnostics );
	return $enabled;
}

/**
 * Disable Premium's editor emoji picker only for an eligible request.
 *
 * @param bool $enabled Premium's decision.
 * @return bool Filtered decision.
 */
function wp_collab_cf_yoast_filter_premium_emoji_picker( $enabled ) {
	$diagnostics = wp_collab_cf_yoast_refresh_request_diagnostics();
	if ( $diagnostics['eligible'] ) {
		$diagnostics['emojiPickerDisabled'] = true;
		wp_collab_cf_yoast_set_request_diagnostics( $diagnostics );
		return false;
	}

	return $enabled;
}

/**
 * Register the owner filter for one post type.
 *
 * @param string $post_type Registered post type name.
 */
function wp_collab_cf_yoast_register_post_type_filter( $post_type ) {
	global $wp_collab_cf_yoast_registered_post_type_filters;

	if ( ! is_string( $post_type ) || '' === $post_type ) {
		return;
	}
	if ( ! isset( $wp_collab_cf_yoast_registered_post_type_filters ) || ! is_array( $wp_collab_cf_yoast_registered_post_type_filters ) ) {
		$wp_collab_cf_yoast_registered_post_type_filters = array();
	}
	if ( isset( $wp_collab_cf_yoast_registered_post_type_filters[ $post_type ] ) ) {
		return;
	}

	add_filter( 'wpseo_enable_editor_features_' . $post_type, 'wp_collab_cf_yoast_filter_editor_features', PHP_INT_MAX );
	$wp_collab_cf_yoast_registered_post_type_filters[ $post_type ] = true;
}

/**
 * Register owner filters for all post types known after init.
 */
function wp_collab_cf_yoast_register_known_post_type_filters() {
	foreach ( (array) get_post_types() as $post_type ) {
		wp_collab_cf_yoast_register_post_type_filter( $post_type );
	}
}

/**
 * Remove handles from every not-yet-printed dependency list.
 *
 * @param object $dependencies WP_Dependencies registry.
 * @param array  $handles      Handles to remove.
 * @return array Handles actually removed.
 */
function wp_collab_cf_yoast_remove_dependency_handles( $dependencies, $handles ) {
	if ( ! is_object( $dependencies ) ) {
		return array();
	}
	$removed = array();
	foreach ( array( 'queue', 'to_do' ) as $list_name ) {
		if ( ! isset( $dependencies->{$list_name} ) || ! is_array( $dependencies->{$list_name} ) ) {
			continue;
		}
		foreach ( $handles as $handle ) {
			if ( in_array( $handle, $dependencies->{$list_name}, true ) ) {
				$removed[] = $handle;
				$dependencies->{$list_name} = array_values( array_diff( $dependencies->{$list_name}, array( $handle ) ) );
			}
		}
	}

	return array_values( array_unique( $removed ) );
}

/**
 * Prune the exact incompatible graph at enqueue and final print seams.
 */
function wp_collab_cf_yoast_prune_editor_assets() {
	global $wp_collab_cf_yoast_unexpected_dependency_handles;

	$diagnostics = wp_collab_cf_yoast_refresh_request_diagnostics();
	if ( ! $diagnostics['ownerFilterSuppressed'] ) {
		return;
	}

	$scripts    = function_exists( 'wp_scripts' ) ? wp_scripts() : null;
	$styles     = function_exists( 'wp_styles' ) ? wp_styles() : null;
	$unexpected = isset( $wp_collab_cf_yoast_unexpected_dependency_handles ) && is_array( $wp_collab_cf_yoast_unexpected_dependency_handles )
		? $wp_collab_cf_yoast_unexpected_dependency_handles
		: array();

	$script_targets        = array_merge( wp_collab_cf_yoast_denied_script_handles(), $unexpected );
	$removed_scripts       = wp_collab_cf_yoast_remove_dependency_handles( $scripts, $script_targets );
	$removed_styles        = wp_collab_cf_yoast_remove_dependency_handles( $styles, wp_collab_cf_yoast_denied_style_handles() );
	$removed_known_scripts = array_values( array_intersect( $removed_scripts, wp_collab_cf_yoast_denied_script_handles() ) );
	$diagnostics['removedScriptHandles'] = array_values(
		array_unique( array_merge( $diagnostics['removedScriptHandles'], $removed_known_scripts ) )
	);
	$diagnostics['removedStyleHandles'] = array_values(
		array_unique( array_merge( $diagnostics['removedStyleHandles'], $removed_styles ) )
	);
	sort( $diagnostics['removedScriptHandles'], SORT_STRING );
	sort( $diagnostics['removedStyleHandles'], SORT_STRING );
	$diagnostics['assetsPruned'] = true;

	$already_printed = array();
	if ( is_object( $scripts ) && isset( $scripts->done ) && is_array( $scripts->done ) ) {
		$already_printed = array_intersect( $script_targets, $scripts->done );
	}
	if ( is_object( $styles ) && isset( $styles->done ) && is_array( $styles->done ) ) {
		$already_printed = array_merge( $already_printed, array_intersect( wp_collab_cf_yoast_denied_style_handles(), $styles->done ) );
	}
	if ( ! empty( $already_printed ) ) {
		$diagnostics['eligible'] = false;
		$diagnostics['applied']  = false;
		$diagnostics['reason']   = 'asset_already_printed';
	}

	wp_collab_cf_yoast_set_request_diagnostics( $diagnostics );
}

/**
 * Determine whether a registry contains the real Yoast box.
 *
 * @param array  $wp_meta_boxes Meta box registry.
 * @param string $screen_id     Current screen ID.
 * @return bool Whether wpseo_meta is present.
 */
function wp_collab_cf_yoast_registry_has_meta_box( $wp_meta_boxes, $screen_id ) {
	if ( ! isset( $wp_meta_boxes[ $screen_id ] ) || ! is_array( $wp_meta_boxes[ $screen_id ] ) ) {
		return false;
	}
	foreach ( $wp_meta_boxes[ $screen_id ] as $priorities ) {
		foreach ( (array) $priorities as $boxes ) {
			foreach ( (array) $boxes as $registered_id => $meta_box ) {
				$meta_box_id = is_array( $meta_box ) && isset( $meta_box['id'] ) ? $meta_box['id'] : $registered_id;
				if ( 'wpseo_meta' === $meta_box_id ) {
					return true;
				}
			}
		}
	}
	return false;
}

/**
 * Render the safe synthetic blocker used only to preserve exclusive editing.
 */
function wp_collab_cf_render_yoast_compatibility_blocker() {
	echo '<p>Yoast SEO compatibility could not be verified for this editor request. Real-time collaboration remains disabled.</p>';
}

/**
 * Finalize Yoast registry behavior after owner and enqueue hooks ran.
 *
 * @param array  $wp_meta_boxes Meta box registry copy.
 * @param string $screen_id     Current screen ID.
 * @param bool   $configured    Whether wpseo_meta is configured.
 * @param bool   $enabled       Whether the site policy is enabled.
 * @param bool   $policy_valid  Whether the complete policy is valid.
 * @return array Registry copy, match flag, and diagnostics.
 */
function wp_collab_cf_yoast_finalize_meta_boxes( $wp_meta_boxes, $screen_id, $configured, $enabled, $policy_valid ) {
	$diagnostics = wp_collab_cf_yoast_refresh_request_diagnostics();
	$result      = array(
		'boxes'       => $wp_meta_boxes,
		'matched'     => false,
		'diagnostics' => $diagnostics,
	);

	if ( ! $configured || ! $policy_valid || ! $enabled ) {
		return $result;
	}

	if (
		$diagnostics['eligible'] &&
		$diagnostics['ownerFilterObserved'] &&
		$diagnostics['ownerFilterSuppressed'] &&
		$diagnostics['assetsPruned']
	) {
		if ( wp_collab_cf_yoast_registry_has_meta_box( $result['boxes'], $screen_id ) ) {
			$diagnostics['eligible'] = false;
			$diagnostics['reason']   = 'meta_box_still_registered';
		} else {
			$diagnostics['applied'] = true;
			$diagnostics['reason']  = 'applied';
			$result['matched']      = true;
		}
	} elseif ( $diagnostics['eligible'] && ! $diagnostics['ownerFilterObserved'] ) {
		$diagnostics['eligible'] = false;
		$diagnostics['reason']   = 'owner_filter_unobserved';
	} elseif ( $diagnostics['eligible'] && ! $diagnostics['ownerFilterSuppressed'] ) {
		$diagnostics['eligible'] = false;
		$diagnostics['reason']   = 'owner_filter_not_suppressed';
	} elseif ( $diagnostics['eligible'] && ! $diagnostics['assetsPruned'] ) {
		$diagnostics['eligible'] = false;
		$diagnostics['reason']   = 'asset_pruning_unobserved';
	}

	$active_yoast = null !== $diagnostics['coreVersion'] || null !== $diagnostics['premiumVersion'];
	if (
		! $diagnostics['applied'] &&
		$active_yoast &&
		$diagnostics['ownerFilterObserved'] &&
		wp_collab_cf_yoast_is_block_editor_post_screen() &&
		! wp_collab_cf_yoast_registry_has_meta_box( $result['boxes'], $screen_id )
	) {
		if ( ! isset( $result['boxes'][ $screen_id ] ) || ! is_array( $result['boxes'][ $screen_id ] ) ) {
			$result['boxes'][ $screen_id ] = array();
		}
		if ( ! isset( $result['boxes'][ $screen_id ]['normal'] ) || ! is_array( $result['boxes'][ $screen_id ]['normal'] ) ) {
			$result['boxes'][ $screen_id ]['normal'] = array();
		}
		if ( ! isset( $result['boxes'][ $screen_id ]['normal']['high'] ) || ! is_array( $result['boxes'][ $screen_id ]['normal']['high'] ) ) {
			$result['boxes'][ $screen_id ]['normal']['high'] = array();
		}
		$result['boxes'][ $screen_id ]['normal']['high']['wp_collab_cf_yoast_compatibility_blocker'] = array(
			'id'       => 'wp_collab_cf_yoast_compatibility_blocker',
			'title'    => 'Yoast SEO compatibility check',
			'callback' => 'wp_collab_cf_render_yoast_compatibility_blocker',
			'args'     => array(),
		);
	}

	wp_collab_cf_yoast_set_request_diagnostics( $diagnostics );
	$result['diagnostics'] = $diagnostics;
	return $result;
}

add_action( 'registered_post_type', 'wp_collab_cf_yoast_register_post_type_filter', PHP_INT_MAX, 1 );
add_action( 'init', 'wp_collab_cf_yoast_register_known_post_type_filters', PHP_INT_MAX );
add_filter( 'wpseo_premium_load_emoji_picker', 'wp_collab_cf_yoast_filter_premium_emoji_picker', PHP_INT_MAX );
add_action( 'admin_enqueue_scripts', 'wp_collab_cf_yoast_prune_editor_assets', PHP_INT_MAX );
add_action( 'admin_print_scripts', 'wp_collab_cf_yoast_prune_editor_assets', 19 );
add_action( 'admin_print_styles', 'wp_collab_cf_yoast_prune_editor_assets', 19 );
add_action( 'admin_print_footer_scripts', 'wp_collab_cf_yoast_prune_editor_assets', 9 );
