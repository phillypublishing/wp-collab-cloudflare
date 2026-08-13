const BLOCKER_MESSAGES = {
	collaboration_not_allowed:
		'WordPress configuration does not allow real-time collaboration.',
	collaboration_not_enabled:
		'Real-time collaboration is not enabled in WordPress.',
	cloudflare_not_configured:
		'WP Collab Cloudflare is missing or has invalid server-side configuration.',
	editor_collaboration_disabled:
		'Gutenberg disabled collaboration for this editor screen.',
	post_type_disabled: 'Gutenberg disabled collaboration for this post type.',
	sync_config_missing:
		'The current post type has no Gutenberg sync configuration.',
	sync_persistence_unsupported:
		'The current post type sync configuration does not support persistence.',
	entity_sync_disabled: 'Gutenberg declined to synchronize this post entity.',
	incompatible_meta_boxes:
		'One or more active meta boxes did not declare RTC compatibility.',
	diagnostics_evaluation_failed:
		'WP Collab Cloudflare could not evaluate one or more Gutenberg collaboration gates.',
};

function blocker( code, details = {} ) {
	return { code, message: BLOCKER_MESSAGES[ code ], ...details };
}

function safelySelect( wp, store ) {
	try {
		return wp?.data?.select?.( store ) || {};
	} catch {
		return {};
	}
}

function safelyCall( callback, fallback = null ) {
	try {
		return typeof callback === 'function' ? callback() : fallback;
	} catch {
		return fallback;
	}
}

function attemptCall( callback, fallback = null ) {
	try {
		return {
			failed: false,
			value: typeof callback === 'function' ? callback() : fallback,
		};
	} catch {
		return { failed: true, value: fallback };
	}
}

function serverMetaBoxById( serverMetaBoxes ) {
	return new Map(
		serverMetaBoxes.map( ( metaBox ) => [ metaBox.id, metaBox ] )
	);
}

function plainText( value ) {
	return String( value || '' )
		.replace( /<[^>]*>/gu, '' )
		.trim();
}

/**
 * Build a read-only, secret-free report from the same gates Gutenberg uses.
 *
 * @param {Object} options
 * @param {Object} options.wp      WordPress browser globals.
 * @param {Object} options.browser Browser global containing Gutenberg flags.
 * @param {Object} options.server  Sanitized server-side diagnostics.
 * @return {Object} Diagnostics report.
 */
export function createRtcDiagnosticsReport( {
	wp,
	// eslint-disable-next-line no-undef
	browser = globalThis,
	server = {},
} ) {
	const editor = safelySelect( wp, 'core/editor' );
	const editPost = safelySelect( wp, 'core/edit-post' );
	const core = safelySelect( wp, 'core' );
	const postType = safelyCall( editor.getCurrentPostType );
	const postId = safelyCall( editor.getCurrentPostId );
	const metaBoxesInitialized =
		typeof editPost.areMetaBoxesInitialized === 'function'
			? safelyCall( editPost.areMetaBoxesInitialized, false ) === true
			: true;
	const entityConfig = safelyCall(
		() => core.getEntityConfig?.( 'postType', postType ),
		{}
	);
	const syncConfig = entityConfig?.syncConfig;
	const serverMetaBoxes = Array.isArray( server.metaBoxes )
		? server.metaBoxes
		: [];
	const clientMetaBoxResult = attemptCall( editPost.getAllMetaBoxes, [] );
	const boxes = Array.isArray( clientMetaBoxResult.value )
		? clientMetaBoxResult.value
		: [];
	const metaBoxLoaderAvailable =
		typeof browser._wpMetaBoxUrl === 'string' &&
		browser._wpMetaBoxUrl.length > 0;
	const metaBoxesRequired =
		metaBoxLoaderAvailable &&
		( boxes.length > 0 || serverMetaBoxes.length > 0 );
	const metaBoxInitializationComplete =
		metaBoxesInitialized || ! metaBoxesRequired;
	const initialized =
		typeof postType === 'string' &&
		postType.length > 0 &&
		metaBoxInitializationComplete;
	const evaluationFailures = [];
	if (
		clientMetaBoxResult.failed ||
		! Array.isArray( clientMetaBoxResult.value )
	) {
		evaluationFailures.push( 'metaBoxes' );
	}
	const serverBoxes = serverMetaBoxById( serverMetaBoxes );
	const metaBoxes = boxes.map( ( metaBox ) => {
		const serverBox = serverBoxes.get( metaBox.id ) || {};
		return {
			id: metaBox.id || serverBox.id || null,
			title: plainText( serverBox.title || metaBox.title ),
			location: serverBox.location || null,
			priority: serverBox.priority || null,
			rtcCompatible: metaBox.__rtc_compatible === true,
			ownerType: serverBox.ownerType || null,
			owner: serverBox.owner || null,
			sourceFile: serverBox.sourceFile || null,
			callback: serverBox.callback || null,
		};
	} );
	const incompatibleMetaBoxes = metaBoxes.filter(
		( metaBox ) => ! metaBox.rtcCompatible
	);
	const disabledPostTypes = Array.isArray(
		browser._wpCollaborationDisabledPostTypes
	)
		? browser._wpCollaborationDisabledPostTypes
		: [];
	const postTypeDisabled =
		server.postTypeDisabled === true ||
		disabledPostTypes.includes( postType );
	const blockers = [];

	if ( initialized && server.collaborationAllowed === false ) {
		blockers.push( blocker( 'collaboration_not_allowed' ) );
	}
	if ( initialized && server.collaborationEnabled === false ) {
		blockers.push( blocker( 'collaboration_not_enabled' ) );
	}
	if ( initialized && server.cloudflareConfigured === false ) {
		blockers.push( blocker( 'cloudflare_not_configured' ) );
	}
	if ( initialized && browser._wpCollaborationEnabled !== true ) {
		blockers.push( blocker( 'editor_collaboration_disabled' ) );
	}
	if ( initialized && postTypeDisabled ) {
		blockers.push( blocker( 'post_type_disabled', { postType } ) );
	}
	if ( initialized && ! syncConfig ) {
		blockers.push( blocker( 'sync_config_missing', { postType } ) );
	} else if ( initialized ) {
		if ( ! syncConfig.supportsPersistence ) {
			blockers.push(
				blocker( 'sync_persistence_unsupported', { postType } )
			);
		}
		const shouldSyncResult = attemptCall(
			() => syncConfig.shouldSync?.( `postType/${ postType }`, postId ),
			undefined
		);
		if ( shouldSyncResult.failed ) {
			evaluationFailures.push( 'shouldSync' );
		} else if ( shouldSyncResult.value === false ) {
			blockers.push( blocker( 'entity_sync_disabled', { postType } ) );
		}
	}
	if ( initialized && evaluationFailures.length ) {
		blockers.push(
			blocker( 'diagnostics_evaluation_failed', {
				gates: evaluationFailures,
			} )
		);
	}
	if ( initialized && incompatibleMetaBoxes.length ) {
		blockers.push(
			blocker( 'incompatible_meta_boxes', {
				metaBoxIds: incompatibleMetaBoxes.map( ( box ) => box.id ),
			} )
		);
	}
	let status = 'initializing';
	if ( initialized ) {
		status = blockers.length ? 'blocked' : 'ready';
	}

	return {
		schema: 'wp-collab-cf-diagnostics/v1',
		status,
		versions: {
			wordpress: server.wordpressVersion || null,
			gutenberg: server.gutenbergVersion || null,
			plugin: server.pluginVersion || null,
		},
		postType,
		gates: {
			initialized,
			metaBoxesInitialized,
			metaBoxLoaderAvailable,
			metaBoxesRequired,
			collaborationAllowed: server.collaborationAllowed ?? null,
			collaborationEnabled: server.collaborationEnabled ?? null,
			cloudflareConfigured: server.cloudflareConfigured ?? null,
			editorCollaborationEnabled:
				browser._wpCollaborationEnabled === true,
			postTypeDisabled,
			syncConfigPresent: Boolean( syncConfig ),
			supportsPersistence: Boolean( syncConfig?.supportsPersistence ),
		},
		blockers,
		metaBoxes,
	};
}

export function shouldAutoLogRtcDiagnostics( report ) {
	return report.status === 'blocked';
}

export function printRtcDiagnostics( report, logger = console ) {
	logger.groupCollapsed?.(
		`WP Collab Cloudflare diagnostics: ${ report.status }`
	);
	logger.table?.( report.blockers );
	if ( report.metaBoxes.length ) {
		logger.table?.( report.metaBoxes );
	}
	logger.info?.( 'Sanitized RTC diagnostics report:', report );
	logger.info?.( 'Run wpCollabCfDiagnostics.log() to print a fresh report.' );
	logger.groupEnd?.();
}
