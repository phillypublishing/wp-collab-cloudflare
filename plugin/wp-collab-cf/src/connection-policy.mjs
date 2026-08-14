export const RESOURCE_LIMIT_CLOSE_CODE = 4008;
export const SESSION_TIMEOUT_CLOSE_CODE = 4001;

// y-partyserver schedules the first reconnect 100ms after an established
// socket closes. Exposing that intent keeps Gutenberg from treating an
// expected bounded-session reconnect as an unrecoverable disconnection.
const SESSION_RETRY_DELAY_MS = 100;

/**
 * Adapt y-partyserver status events to Gutenberg's richer connection contract.
 *
 * y-partyserver emits `connection-close` before its bare `disconnected`
 * status. Remember an expected session-timeout close long enough to add
 * Gutenberg's automatic-retry hint, then clear it once the replacement socket
 * connects. Other close reasons and status fields pass through unchanged.
 *
 * @param {{
 *   destroy: () => void,
 *   off: (event: string, callback: (value: unknown) => void) => void,
 *   on: (event: string, callback: (value: any) => void) => void,
 *   once: (event: string, callback: (value: any) => void) => void
 * }} provider y-partyserver provider.
 * @return {typeof provider} A transparent provider facade with bridged statuses.
 */
export function createProviderStatusBridge( provider ) {
	const boundMethods = new Map();
	const listeners = new Set();
	let sessionReconnectPending = false;

	const onConnectionClose = ( event ) => {
		sessionReconnectPending = event.code === SESSION_TIMEOUT_CLOSE_CODE;
	};
	const onStatus = ( status ) => {
		const bridgedStatus =
			sessionReconnectPending && status.status === 'disconnected'
				? {
						...status,
						willAutoRetryInMs: SESSION_RETRY_DELAY_MS,
				  }
				: status;

		for ( const listener of [ ...listeners ] ) {
			listener( bridgedStatus );
		}

		if ( status.status === 'connected' ) {
			sessionReconnectPending = false;
		}
	};

	provider.on( 'connection-close', onConnectionClose );
	provider.on( 'status', onStatus );

	const facadeMethods = {
		destroy: () => {
			provider.off( 'connection-close', onConnectionClose );
			provider.off( 'status', onStatus );
			listeners.clear();
			provider.destroy();
		},
		off: ( event, callback ) => {
			if ( event === 'status' ) {
				listeners.delete( callback );
				return;
			}
			provider.off( event, callback );
		},
		on: ( event, callback ) => {
			if ( event === 'status' ) {
				listeners.add( callback );
				return;
			}
			provider.on( event, callback );
		},
		once: ( event, callback ) => {
			if ( event !== 'status' ) {
				provider.once( event, callback );
				return;
			}
			const onceCallback = ( ...args ) => {
				facadeMethods.off( event, onceCallback );
				callback( ...args );
			};
			facadeMethods.on( event, onceCallback );
		},
	};

	return new Proxy( provider, {
		get: ( target, property ) => {
			if ( Object.hasOwn( facadeMethods, property ) ) {
				return facadeMethods[ property ];
			}
			const value = Reflect.get( target, property, target );
			if ( typeof value !== 'function' ) {
				return value;
			}
			if ( ! boundMethods.has( property ) ) {
				boundMethods.set( property, value.bind( target ) );
			}
			return boundMethods.get( property );
		},
		set: ( target, property, value ) =>
			Reflect.set( target, property, value, target ),
	} );
}

/**
 * Resource-limit closes are terminal until an operator reviews the room.
 * Session-timeout closes intentionally remain reconnectable so the
 * provider can mint a fresh short-lived credential.
 *
 * @param {{ code?: number }}          event               WebSocket close event.
 * @param {{ disconnect: () => void }} provider            Collaboration provider.
 * @param {() => void}                 notifyTerminalClose Persistent editor notice callback.
 * @return {boolean} Whether the close was terminal.
 */
export function handleConnectionClose( event, provider, notifyTerminalClose ) {
	if ( event.code !== RESOURCE_LIMIT_CLOSE_CODE ) {
		return false;
	}

	provider.disconnect();
	notifyTerminalClose();
	return true;
}
