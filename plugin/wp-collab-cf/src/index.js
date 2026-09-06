/* global globalThis */
import { addFilter } from '@wordpress/hooks';
import apiFetch from '@wordpress/api-fetch';
import YProvider from 'y-partyserver/provider';

import {
	createProviderStatusBridge,
	handleConnectionClose,
} from './connection-policy.mjs';
import {
	createRtcDiagnosticsReport,
	printRtcDiagnostics,
	shouldAutoLogRtcDiagnostics,
} from './rtc-diagnostics.mjs';
import { isSupportedSyncObject } from './sync-object-policy.mjs';
import { registerMetaBoxSuppressionUi } from './meta-box-suppression-ui.js';
import { registerYoastPrimaryCategoryBridge } from './yoast-primary-category.js';
import {
	createOutageReporter,
	createConnectionTelemetry,
	observeOutageModal,
} from './outage-telemetry.mjs';

const config = window.wpCollabCf || {};

let outageReporter;
try {
	if ( config.outageTelemetryUrl && window.crypto?.randomUUID ) {
		outageReporter = createOutageReporter( {
			getContext: () => ( {
				postId: window.wp.data
					.select( 'core/editor' )
					.getCurrentPostId(),
				versions: config.versions,
				online: window.navigator.onLine,
				visibility: document.visibilityState,
			} ),
			send: async ( data ) => {
				const controller = new AbortController();
				const timeout = window.setTimeout(
					() => controller.abort(),
					5000
				);
				try {
					await apiFetch( {
						url: config.outageTelemetryUrl,
						method: 'POST',
						data,
						signal: controller.signal,
					} );
				} finally {
					window.clearTimeout( timeout );
				}
			},
		} );
		const observe = () => {
			try {
				observeOutageModal( {
					document,
					MutationObserver: window.MutationObserver,
					reporter: outageReporter,
				} );
			} catch {
				/* Diagnostics are optional. */
			}
		};
		if ( document.body ) {
			observe();
		} else {
			document.addEventListener( 'DOMContentLoaded', observe, {
				once: true,
			} );
		}
		for ( const event of [ 'online', 'offline' ] ) {
			window.addEventListener( event, () => {
				outageReporter.record( event );
				if ( event === 'online' ) {
					void outageReporter.flush();
				}
			} );
		}
		document.addEventListener( 'visibilitychange', () =>
			outageReporter.record( 'visibility_changed' )
		);
		window.addEventListener( 'pagehide', () => {
			void outageReporter.flush();
		} );
	}
} catch {
	/* Telemetry must not prevent the editor provider from registering. */
}

function currentDiagnosticsReport() {
	return createRtcDiagnosticsReport( {
		wp: window.wp,
		browser: window,
		server: window.wpCollabCfDiagnosticsServer || {},
	} );
}

let lastAutomaticDiagnostics = null;
function maybeLogRtcDiagnostics() {
	const report = currentDiagnosticsReport();
	if ( ! shouldAutoLogRtcDiagnostics( report ) ) {
		return report;
	}
	const signature = JSON.stringify( {
		blockers: report.blockers,
		metaBoxes: report.metaBoxes,
	} );
	if ( signature !== lastAutomaticDiagnostics ) {
		lastAutomaticDiagnostics = signature;
		printRtcDiagnostics( report );
	}
	return report;
}

let diagnosticsScheduled = false;
let unsubscribeDiagnostics = null;
function scheduleRtcDiagnostics() {
	if ( diagnosticsScheduled ) {
		return;
	}
	diagnosticsScheduled = true;
	window.setTimeout( () => {
		diagnosticsScheduled = false;
		const report = maybeLogRtcDiagnostics();
		if ( report.gates.initialized && unsubscribeDiagnostics ) {
			unsubscribeDiagnostics();
			unsubscribeDiagnostics = null;
		}
	}, 0 );
}

window.wpCollabCfDiagnostics = Object.freeze( {
	report: currentDiagnosticsReport,
	log: () => {
		const report = currentDiagnosticsReport();
		printRtcDiagnostics( report );
		return report;
	},
} );
window.addEventListener(
	'wp-collab-cf-diagnostics-ready',
	scheduleRtcDiagnostics
);
window._wpLoadBlockEditor?.then( () => {
	scheduleRtcDiagnostics();
} );
unsubscribeDiagnostics =
	window.wp?.data?.subscribe?.( scheduleRtcDiagnostics, 'core/edit-post' ) ||
	null;

function noOpProvider() {
	return { destroy: () => {}, on: () => {} };
}

async function requestCredentials( objectType, objectId, trace = {} ) {
	const credentials = await apiFetch( {
		url: config.tokenUrl,
		method: 'POST',
		data: { objectType, objectId, ...trace },
	} );
	if ( ! credentials.room || ! credentials.token ) {
		throw new Error( 'Credential response is incomplete' );
	}
	return credentials;
}

class AuthenticatedWebSocket extends globalThis.WebSocket {
	constructor( address, protocols = [] ) {
		const url = new URL( address );
		const token = url.searchParams.get( 'token' );
		if ( ! token ) {
			throw new Error( 'WebSocket credential is missing' );
		}
		url.searchParams.delete( 'token' );
		const requestedProtocols = Array.isArray( protocols )
			? protocols
			: [ protocols ];
		super( url, [
			...requestedProtocols,
			'wp-collab-v1',
			`wp-collab-token.${ token }`,
		] );
	}
}

if ( config.wsUrl && config.tokenUrl ) {
	addFilter( 'sync.providers', 'wp-collab-cf/websocket-provider', () => {
		return [
			async ( { objectType, objectId, ydoc, awareness } ) => {
				const Y = window.wp?.sync?.Y;
				if ( ! Y ) {
					// eslint-disable-next-line no-console
					console.error(
						'WP Collab CF: wp.sync.Y not found — wp-sync may not be loaded.'
					);
					return noOpProvider();
				}

				if ( ! isSupportedSyncObject( objectType, objectId ) ) {
					// WordPress performs authoritative permission checks. Skip
					// malformed types and entity shapes that it will never grant.
					return noOpProvider();
				}

				let telemetry;
				try {
					telemetry =
						outageReporter &&
						createConnectionTelemetry(
							outageReporter,
							objectType,
							objectId
						);
				} catch {
					/* Optional diagnostics. */
				}
				const getCredentials = () =>
					telemetry
						? telemetry.credentials( ( trace ) =>
								requestCredentials(
									objectType,
									objectId,
									trace
								)
						  )
						: requestCredentials( objectType, objectId );
				let nextCredentials;
				try {
					nextCredentials = await getCredentials();
				} catch ( error ) {
					// eslint-disable-next-line no-console
					console.error(
						'WP Collab CF: unable to authorize WebSocket connection.',
						error
					);
					telemetry?.destroy();
					return noOpProvider();
				}

				const room = nextCredentials.room;
				const endpoint = new URL( config.wsUrl );
				const provider = new YProvider( endpoint.host, room, ydoc, {
					party: 'collaboration',
					protocol: endpoint.protocol.replace( ':', '' ),
					awareness,
					connect: false,
					WebSocketPolyfill: AuthenticatedWebSocket,
					params: async () => {
						const credentials =
							nextCredentials || ( await getCredentials() );
						nextCredentials = undefined;
						if ( credentials.room !== room ) {
							throw new Error(
								'Credential room changed during reconnect'
							);
						}
						return { token: credentials.token };
					},
				} );
				try {
					telemetry?.attach( provider );
				} catch {
					/* Optional diagnostics. */
				}
				provider.on( 'connection-close', ( event ) => {
					handleConnectionClose( event, provider, () => {
						window.wp.data
							.dispatch( 'core/notices' )
							.createErrorNotice(
								'Real-time collaboration stopped because this room reached a server resource limit. Save your work and ask an administrator to review the room before reconnecting.',
								{
									id: 'wp-collab-cf-resource-limit',
									isDismissible: false,
								}
							);
					} );
				} );
				const statusBridge = createProviderStatusBridge( provider, {
					// Collections only invalidate query results; they do not
					// carry editable entity state. Do not publish their transient
					// disconnects into Gutenberg's global connection status.
					publishRetryableDisconnects: objectId !== null,
					onDestroy: () => telemetry?.destroy(),
				} );
				provider.connect().catch( ( error ) => {
					// eslint-disable-next-line no-console
					console.error(
						'WP Collab CF: unable to open WebSocket connection.',
						error
					);
				} );
				return statusBridge;
			},
		];
	} );
}

registerMetaBoxSuppressionUi();
registerYoastPrimaryCategoryBridge();
