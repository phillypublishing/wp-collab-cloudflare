import { addFilter } from '@wordpress/hooks';
import apiFetch from '@wordpress/api-fetch';
import YProvider from 'y-partyserver/provider';

const config = window.wpCollabCf || {};

function noOpProvider() {
	return { destroy: () => {}, on: () => {} };
}

async function requestCredentials( objectType, objectId ) {
	const credentials = await apiFetch( {
		url: config.tokenUrl,
		method: 'POST',
		data: { objectType, objectId },
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
	addFilter(
		'sync.providers',
		'wp-collab-cf/websocket-provider',
		() => {
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

					if (
						! /^postType\/[a-z0-9_-]+$/.test( objectType ) ||
						! /^[1-9]\d*$/.test( String( objectId ) )
					) {
						// Secure collection/entity authorization needs a distinct
						// capability model. Do not request credentials for an object
						// this version deliberately does not authorize.
						return noOpProvider();
					}

					let nextCredentials;
					try {
						nextCredentials = await requestCredentials(
							objectType,
							objectId
						);
					} catch ( error ) {
						// eslint-disable-next-line no-console
						console.error(
							'WP Collab CF: unable to authorize WebSocket connection.',
							error
						);
						return noOpProvider();
					}

					const room = nextCredentials.room;
					const endpoint = new URL( config.wsUrl );
					return new YProvider( endpoint.host, room, ydoc, {
						party: 'collaboration',
						protocol: endpoint.protocol.replace( ':', '' ),
						awareness,
						WebSocketPolyfill: AuthenticatedWebSocket,
						params: async () => {
							const credentials =
								nextCredentials ||
								( await requestCredentials(
									objectType,
									objectId
								) );
							nextCredentials = undefined;
							if ( credentials.room !== room ) {
								throw new Error(
									'Credential room changed during reconnect'
								);
							}
							return { token: credentials.token };
						},
					} );
				},
			];
		}
	);
}
