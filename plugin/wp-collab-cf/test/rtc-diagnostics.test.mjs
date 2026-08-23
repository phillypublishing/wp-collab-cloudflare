import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createRtcDiagnosticsReport,
	shouldAutoLogRtcDiagnostics,
} from '../src/rtc-diagnostics.mjs';

function createWp( {
	metaBoxes = [],
	metaBoxesInitialized = true,
	metaBoxesError = null,
	shouldSyncError = null,
	syncConfig,
} = {} ) {
	const configuredSync = syncConfig
		? {
				...syncConfig,
				shouldSync: shouldSyncError
					? () => {
							throw shouldSyncError;
					  }
					: syncConfig.shouldSync,
		  }
		: syncConfig;
	return {
		data: {
			select: ( store ) => {
				if ( store === 'core/editor' ) {
					return {
						getCurrentPostId: () => 42,
						getCurrentPostType: () => 'post',
					};
				}
				if ( store === 'core/edit-post' ) {
					return {
						areMetaBoxesInitialized: () => metaBoxesInitialized,
						getAllMetaBoxes: () => {
							if ( metaBoxesError ) {
								throw metaBoxesError;
							}
							return metaBoxes;
						},
					};
				}
				if ( store === 'core' ) {
					return {
						getEntityConfig: () => ( {
							syncConfig: configuredSync,
						} ),
					};
				}
				return {};
			},
		},
	};
}

const readyServerReport = {
	collaborationAllowed: true,
	collaborationEnabled: true,
	cloudflareConfigured: true,
	postTypeDisabled: false,
	metaBoxes: [],
};

test( 'reports the exact meta boxes that make Gutenberg disable RTC', () => {
	const productionBlockers = [
		{ id: 'pp_checklist_meta', title: 'Checklist' },
		{
			id: 'broadstreet_visibility_sectionid',
			title: '<span class="dashicons dashicons-format-image"></span> Broadstreet Options',
		},
		{ id: 'wpseo_meta', title: 'Yoast SEO Premium' },
		{
			id: 'broadstreet_sposnor_sectionid',
			title: '<span class="dashicons dashicons-performance"></span> Sponsored Content',
		},
		{
			id: 'mepr_unauthorized_message',
			title: 'MemberPress Unauthorized Access',
		},
		{ id: 'broadstreet_sectionid', title: 'Broadstreet Zone Info' },
	];
	const wp = createWp( {
		metaBoxes: [
			{ id: 'safe-box', title: 'Safe', __rtc_compatible: true },
			...productionBlockers,
		],
		syncConfig: {
			supportsPersistence: true,
			shouldSync: () => true,
		},
	} );
	const report = createRtcDiagnosticsReport( {
		wp,
		browser: {
			__experimentalEnableRealTimeCollaboration: true,
			_wpCollaborationDisabledPostTypes: [],
		},
		server: {
			...readyServerReport,
			metaBoxes: [
				{
					id: 'wpseo_meta',
					owner: 'wordpress-seo-premium',
					ownerType: 'plugin',
					sourceFile:
						'wordpress-seo-premium/admin/metabox/class-metabox.php',
				},
			],
		},
	} );

	assert.equal( report.status, 'blocked' );
	assert.deepEqual(
		report.blockers.map( ( blocker ) => blocker.code ),
		[ 'incompatible_meta_boxes' ]
	);
	assert.deepEqual(
		report.metaBoxes.map( ( box ) => ( {
			id: box.id,
			rtcCompatible: box.rtcCompatible,
			owner: box.owner,
		} ) ),
		[
			{ id: 'safe-box', rtcCompatible: true, owner: null },
			{
				id: 'pp_checklist_meta',
				rtcCompatible: false,
				owner: null,
			},
			{
				id: 'broadstreet_visibility_sectionid',
				rtcCompatible: false,
				owner: null,
			},
			{
				id: 'wpseo_meta',
				rtcCompatible: false,
				owner: 'wordpress-seo-premium',
			},
			{
				id: 'broadstreet_sposnor_sectionid',
				rtcCompatible: false,
				owner: null,
			},
			{
				id: 'mepr_unauthorized_message',
				rtcCompatible: false,
				owner: null,
			},
			{
				id: 'broadstreet_sectionid',
				rtcCompatible: false,
				owner: null,
			},
		]
	);
	assert.deepEqual(
		report.blockers[ 0 ].metaBoxIds,
		productionBlockers.map( ( metaBox ) => metaBox.id )
	);
	assert.equal( report.metaBoxes[ 2 ].title, 'Broadstreet Options' );
	assert.equal( report.metaBoxes[ 4 ].title, 'Sponsored Content' );
	assert.equal( shouldAutoLogRtcDiagnostics( report ), true );
} );

test( 'reports the server, editor, and sync gates without exposing configuration values', () => {
	const report = createRtcDiagnosticsReport( {
		wp: createWp(),
		browser: {
			__experimentalEnableRealTimeCollaboration: false,
			_wpCollaborationDisabledPostTypes: [ 'post' ],
		},
		server: {
			collaborationAllowed: false,
			collaborationEnabled: false,
			cloudflareConfigured: false,
			postTypeDisabled: true,
			metaBoxes: [],
		},
	} );

	assert.equal( report.status, 'blocked' );
	assert.deepEqual(
		report.blockers.map( ( blocker ) => blocker.code ),
		[
			'collaboration_not_allowed',
			'collaboration_not_enabled',
			'cloudflare_not_configured',
			'editor_collaboration_disabled',
			'post_type_disabled',
			'sync_config_missing',
		]
	);
	assert.equal( JSON.stringify( report ).includes( 'secret' ), false );
} );

test( 'stays quiet automatically when every RTC gate is ready', () => {
	const report = createRtcDiagnosticsReport( {
		wp: createWp( {
			metaBoxes: [
				{ id: 'safe-box', title: 'Safe', __rtc_compatible: true },
			],
			syncConfig: {
				supportsPersistence: true,
				shouldSync: () => true,
			},
		} ),
		browser: {
			__experimentalEnableRealTimeCollaboration: true,
			_wpCollaborationDisabledPostTypes: [],
		},
		server: readyServerReport,
	} );

	assert.equal( report.status, 'ready' );
	assert.deepEqual( report.blockers, [] );
	assert.equal( shouldAutoLogRtcDiagnostics( report ), false );
} );

test( 'recognizes the Gutenberg 23.8 real-time collaboration experiment', () => {
	const report = createRtcDiagnosticsReport( {
		wp: createWp( {
			syncConfig: {
				supportsPersistence: true,
				shouldSync: () => true,
			},
		} ),
		browser: {
			__experimentalEnableRealTimeCollaboration: true,
			_wpCollaborationDisabledPostTypes: [],
		},
		server: readyServerReport,
	} );

	assert.equal( report.status, 'ready' );
	assert.equal( report.gates.editorCollaborationEnabled, true );
	assert.deepEqual( report.blockers, [] );
} );

test( 'ignores the retired collaboration experiment flag', () => {
	const report = createRtcDiagnosticsReport( {
		wp: createWp( {
			syncConfig: {
				supportsPersistence: true,
				shouldSync: () => true,
			},
		} ),
		browser: {
			_wpCollaborationEnabled: true,
			_wpCollaborationDisabledPostTypes: [],
		},
		server: readyServerReport,
	} );

	assert.equal( report.status, 'blocked' );
	assert.equal( report.gates.editorCollaborationEnabled, false );
	assert.deepEqual(
		report.blockers.map( ( blocker ) => blocker.code ),
		[ 'editor_collaboration_disabled' ]
	);
} );

test( 'does not report false blockers before Gutenberg initializes the editor', () => {
	const report = createRtcDiagnosticsReport( {
		wp: createWp( {
			metaBoxes: [ { id: 'legacy-box', title: 'Legacy' } ],
			metaBoxesInitialized: false,
		} ),
		browser: { _wpMetaBoxUrl: 'https://example.test/wp-admin/post.php' },
		server: {
			collaborationAllowed: false,
			collaborationEnabled: false,
			cloudflareConfigured: false,
		},
	} );

	assert.equal( report.status, 'initializing' );
	assert.equal( report.gates.initialized, false );
	assert.equal( report.gates.metaBoxesInitialized, false );
	assert.deepEqual( report.blockers, [] );
	assert.equal( shouldAutoLogRtcDiagnostics( report ), false );
} );

test( 'uses sanitized server meta boxes while the Gutenberg store initializes', () => {
	const report = createRtcDiagnosticsReport( {
		wp: createWp( {
			metaBoxes: [],
			metaBoxesInitialized: false,
		} ),
		browser: { _wpMetaBoxUrl: 'https://example.test/wp-admin/post.php' },
		server: {
			collaborationAllowed: false,
			collaborationEnabled: false,
			cloudflareConfigured: false,
			metaBoxes: [ { id: 'legacy-box', title: 'Legacy' } ],
		},
	} );

	assert.equal( report.status, 'initializing' );
	assert.equal( report.gates.initialized, false );
	assert.equal( report.gates.metaBoxesInitialized, false );
	assert.equal( report.gates.metaBoxesRequired, true );
	assert.deepEqual( report.blockers, [] );
} );

test( 'finishes initialization when the singular loader has no meta boxes', () => {
	const report = createRtcDiagnosticsReport( {
		wp: createWp( {
			metaBoxes: [],
			metaBoxesInitialized: false,
			syncConfig: {
				supportsPersistence: true,
				shouldSync: () => true,
			},
		} ),
		browser: {
			__experimentalEnableRealTimeCollaboration: true,
			_wpCollaborationDisabledPostTypes: [],
			_wpMetaBoxUrl: 'https://example.test/wp-admin/post.php',
		},
		server: readyServerReport,
	} );

	assert.equal( report.status, 'ready' );
	assert.equal( report.gates.initialized, true );
	assert.equal( report.gates.metaBoxesInitialized, false );
	assert.equal( report.gates.metaBoxesRequired, false );
	assert.equal( report.gates.metaBoxLoaderAvailable, true );
	assert.deepEqual( report.blockers, [] );
} );

test( 'ignores server meta boxes that Gutenberg removes from the editor store', () => {
	const report = createRtcDiagnosticsReport( {
		wp: createWp( {
			metaBoxes: [],
			syncConfig: {
				supportsPersistence: true,
				shouldSync: () => true,
			},
		} ),
		browser: {
			__experimentalEnableRealTimeCollaboration: true,
			_wpCollaborationDisabledPostTypes: [],
		},
		server: {
			...readyServerReport,
			metaBoxes: [
				{
					id: 'submitdiv',
					title: 'Publish',
					rtcCompatible: false,
					ownerType: 'wordpress-core',
					owner: 'wordpress-core',
				},
			],
		},
	} );

	assert.equal( report.status, 'ready' );
	assert.deepEqual( report.metaBoxes, [] );
	assert.deepEqual( report.blockers, [] );
} );

test( 'uses the Gutenberg store as the compatibility authority', () => {
	const report = createRtcDiagnosticsReport( {
		wp: createWp( {
			metaBoxes: [ { id: 'late-box', title: 'Late compatibility' } ],
			syncConfig: {
				supportsPersistence: true,
				shouldSync: () => true,
			},
		} ),
		browser: {
			__experimentalEnableRealTimeCollaboration: true,
			_wpCollaborationDisabledPostTypes: [],
			_wpMetaBoxUrl: 'https://example.test/wp-admin/post.php',
		},
		server: {
			...readyServerReport,
			metaBoxes: [
				{
					id: 'late-box',
					title: 'Late compatibility',
					rtcCompatible: true,
				},
			],
		},
	} );

	assert.equal( report.status, 'blocked' );
	assert.equal( report.metaBoxes[ 0 ].rtcCompatible, false );
	assert.deepEqual( report.blockers[ 0 ].metaBoxIds, [ 'late-box' ] );
} );

test( 'reports site-wide suppression while keeping the browser store authoritative for remaining blockers', () => {
	const report = createRtcDiagnosticsReport( {
		wp: createWp( {
			metaBoxes: [ { id: 'still-rendered', title: 'Still rendered' } ],
			syncConfig: {
				supportsPersistence: true,
				shouldSync: () => true,
			},
		} ),
		browser: {
			__experimentalEnableRealTimeCollaboration: true,
			_wpCollaborationDisabledPostTypes: [],
		},
		server: {
			...readyServerReport,
			metaBoxes: [ { id: 'still-rendered', title: 'Still rendered' } ],
			metaBoxSuppression: {
				configuredIds: [ 'suppressed-box', 'missing-box' ],
				enabled: true,
				effective: true,
				matchedIds: [ 'suppressed-box' ],
				suppressedIds: [ 'suppressed-box' ],
				unmatchedIds: [ 'missing-box' ],
				remainingBlockerIds: [ 'server-guess-must-not-win' ],
				warning: null,
				originalMetaBoxes: [
					{
						id: 'suppressed-box',
						title: 'Suppressed',
						ownerType: 'plugin',
						owner: 'fixture-plugin',
					},
				],
			},
		},
	} );

	assert.deepEqual( report.metaBoxSuppression, {
		configuredIds: [ 'suppressed-box', 'missing-box' ],
		enabled: true,
		effective: true,
		matchedIds: [ 'suppressed-box' ],
		suppressedIds: [ 'suppressed-box' ],
		unmatchedIds: [ 'missing-box' ],
		remainingBlockerIds: [ 'still-rendered' ],
		warning: null,
		originalMetaBoxes: [
			{
				id: 'suppressed-box',
				title: 'Suppressed',
				ownerType: 'plugin',
				owner: 'fixture-plugin',
			},
		],
	} );
	assert.deepEqual( report.blockers[ 0 ].metaBoxIds, [ 'still-rendered' ] );
} );

test( 'reports stable sanitized compatibility adapter state', () => {
	const report = createRtcDiagnosticsReport( {
		wp: createWp( {
			syncConfig: {
				supportsPersistence: true,
				shouldSync: () => true,
			},
		} ),
		browser: { __experimentalEnableRealTimeCollaboration: true },
		server: {
			...readyServerReport,
			compatibilityAdapters: {
				memberpress: {
					adapter: 'memberpress_scale_1_12_17',
					policyId: 'memberpress_scale',
					versionPolicy: 'minimum',
					minimumVersions: { memberpress: '1.12.17' },
					configured: true,
					eligible: true,
					applied: true,
					reason: 'applied',
					version: '1.12.17',
					proprietaryPath: '/srv/memberpress/app/controllers/MeprAppCtrl.php',
				},
				yoast: {
					adapter: 'yoast_seo_core_premium_28_2',
					policyId: 'yoast_seo_core_premium',
					versionPolicy: 'minimum',
					minimumVersions: {
						core: '28.2',
						premium: '28.2',
						news: '13.3',
						video: '15.2',
						local: '15.8',
					},
					configured: true,
					eligible: false,
					applied: false,
					reason: 'protected_content',
					coreVersion: '28.2',
					premiumVersion: '28.2',
					newsVersion: '13.3',
					videoVersion: '15.2',
					localVersion: '15.8',
					ownerFilterObserved: true,
					ownerFilterSuppressed: false,
					emojiPickerDisabled: false,
					protectedContent: {
						state: 'protected',
						reason: 'protected_block',
						block: 'yoast-seo/related-links',
						content: '<!-- private -->',
					},
					addonState: 'supported',
					unsupportedAddonCount: 0,
					dependencyState: 'supported',
					unexpectedDependencyCount: 0,
					assetsPruned: false,
					removedScriptHandles: [ 'yoast-seo-post-edit' ],
					removedStyleHandles: [ 'yoast-seo-metabox-css' ],
					limitation: 'premium_prominent_words_may_be_stale',
					pluginPath: '/srv/wordpress-seo-premium/wp-seo-premium.php',
				},
			},
		},
	} );

	assert.deepEqual( report.compatibilityAdapters.memberpress, {
		adapter: 'memberpress_scale_1_12_17',
		policyId: 'memberpress_scale',
		versionPolicy: 'minimum',
		minimumVersions: { memberpress: '1.12.17' },
		configured: true,
		eligible: true,
		applied: true,
		reason: 'applied',
		version: '1.12.17',
	} );
	assert.equal(
		report.compatibilityAdapters.yoast.adapter,
		'yoast_seo_core_premium_28_2'
	);
	assert.equal(
		report.compatibilityAdapters.yoast.policyId,
		'yoast_seo_core_premium'
	);
	assert.equal( report.compatibilityAdapters.yoast.versionPolicy, 'minimum' );
	assert.deepEqual( report.compatibilityAdapters.yoast.minimumVersions, {
		core: '28.2',
		premium: '28.2',
		news: '13.3',
		video: '15.2',
		local: '15.8',
	} );
	assert.equal( report.compatibilityAdapters.yoast.reason, 'protected_content' );
	assert.equal( report.compatibilityAdapters.yoast.newsVersion, '13.3' );
	assert.equal( report.compatibilityAdapters.yoast.videoVersion, '15.2' );
	assert.equal( report.compatibilityAdapters.yoast.localVersion, '15.8' );
	assert.deepEqual( report.compatibilityAdapters.yoast.protectedContent, {
		state: 'protected',
		reason: 'protected_block',
		block: 'yoast-seo/related-links',
	} );
	assert.equal( report.compatibilityAdapters.yoast.unexpectedDependencyCount, 0 );
	assert.equal(
		Object.hasOwn(
			report.compatibilityAdapters.yoast,
			'unexpectedDependencyHandles'
		),
		false
	);
	assert.deepEqual(
		Object.keys( report.compatibilityAdapters ),
		[ 'memberpress', 'yoast' ]
	);
	assert.equal( JSON.stringify( report.compatibilityAdapters ).includes( '/srv/' ), false );
	assert.equal( JSON.stringify( report.compatibilityAdapters ).includes( '<!-- private -->' ), false );
} );

test( 'fails closed when Gutenberg meta-box evaluation throws', () => {
	const report = createRtcDiagnosticsReport( {
		wp: createWp( {
			metaBoxesError: new Error( 'selector unavailable' ),
			syncConfig: {
				supportsPersistence: true,
				shouldSync: () => true,
			},
		} ),
		browser: {
			__experimentalEnableRealTimeCollaboration: true,
			_wpCollaborationDisabledPostTypes: [],
		},
		server: readyServerReport,
	} );

	assert.equal( report.status, 'blocked' );
	assert.deepEqual( report.metaBoxes, [] );
	assert.deepEqual(
		report.blockers.map( ( item ) => item.code ),
		[ 'diagnostics_evaluation_failed' ]
	);
	assert.deepEqual( report.blockers[ 0 ].gates, [ 'metaBoxes' ] );
	assert.equal( shouldAutoLogRtcDiagnostics( report ), true );
} );

test( 'fails closed when Gutenberg shouldSync evaluation throws', () => {
	const report = createRtcDiagnosticsReport( {
		wp: createWp( {
			shouldSyncError: new Error( 'sync policy unavailable' ),
			syncConfig: {
				supportsPersistence: true,
				shouldSync: () => true,
			},
		} ),
		browser: {
			__experimentalEnableRealTimeCollaboration: true,
			_wpCollaborationDisabledPostTypes: [],
		},
		server: readyServerReport,
	} );

	assert.equal( report.status, 'blocked' );
	assert.deepEqual(
		report.blockers.map( ( item ) => item.code ),
		[ 'diagnostics_evaluation_failed' ]
	);
	assert.deepEqual( report.blockers[ 0 ].gates, [ 'shouldSync' ] );
} );
