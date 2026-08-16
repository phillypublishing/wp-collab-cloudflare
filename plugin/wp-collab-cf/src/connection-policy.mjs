export const RESOURCE_LIMIT_CLOSE_CODE = 4008;
export const SESSION_TIMEOUT_CLOSE_CODE = 4001;

const PROTOCOL_ERROR_CLOSE_CODE = 1002;
const POLICY_VIOLATION_CLOSE_CODE = 1008;
const BACKGROUND_RETRIES_FAILED_THRESHOLD = 3;
const CONNECTION_STABLE_RESET_DELAY_MS = 2_000;

function isTerminalClose( code ) {
	return [
		PROTOCOL_ERROR_CLOSE_CODE,
		POLICY_VIOLATION_CLOSE_CODE,
		RESOURCE_LIMIT_CLOSE_CODE,
	].includes( code );
}

/**
 * Adapt y-partyserver status events to Gutenberg's richer connection contract.
 *
 * y-partyserver emits `connection-close` before its bare `disconnected`
 * status, and emits no disconnected status when a connection attempt fails
 * before opening. Emit one enriched disconnected status from the close event
 * so Gutenberg can keep ordinary transient retries in the background. The
 * retry delay mirrors y-partyserver's exponential backoff exactly.
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
	let consecutiveFailedRetries = 0;
	let connectionStableTimer = null;
	let destroyed = false;
	let suppressNextDisconnected = false;
	const clearConnectionStableTimer = () => {
		if ( connectionStableTimer !== null ) {
			clearTimeout( connectionStableTimer );
			connectionStableTimer = null;
		}
	};

	const onConnectionClose = ( event ) => {
		const retryable = ! isTerminalClose( event.code );
		const closedBeforeStable = connectionStableTimer !== null;
		clearConnectionStableTimer();
		if (
			retryable &&
			( provider.wsconnected === false || closedBeforeStable )
		) {
			consecutiveFailedRetries += 1;
		}
		const providerFailedRetries =
			provider.wsUnsuccessfulReconnects +
			( provider.wsconnected === false ? 1 : 0 );
		suppressNextDisconnected = provider.wsconnected === true;
		const status = retryable
			? {
					status: 'disconnected',
					willAutoRetryInMs: Math.min(
						2 ** providerFailedRetries * 100,
						provider.maxBackoffTime
					),
					backgroundRetriesFailed:
						consecutiveFailedRetries >=
						BACKGROUND_RETRIES_FAILED_THRESHOLD,
			  }
			: { status: 'disconnected' };

		for ( const listener of [ ...listeners ] ) {
			listener( status );
		}
	};
	const onStatus = ( status ) => {
		if ( status.status === 'disconnected' && suppressNextDisconnected ) {
			suppressNextDisconnected = false;
			return;
		}

		for ( const listener of [ ...listeners ] ) {
			listener( status );
		}

		if ( status.status === 'connected' ) {
			clearConnectionStableTimer();
			connectionStableTimer = setTimeout( () => {
				consecutiveFailedRetries = 0;
				connectionStableTimer = null;
			}, CONNECTION_STABLE_RESET_DELAY_MS );
			suppressNextDisconnected = false;
		}
	};

	provider.on( 'connection-close', onConnectionClose );
	provider.on( 'status', onStatus );

	const facadeMethods = {
		destroy: () => {
			if ( destroyed ) {
				return;
			}
			destroyed = true;
			clearConnectionStableTimer();
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
	if ( ! isTerminalClose( event.code ) ) {
		return false;
	}

	provider.disconnect();
	if ( event.code === RESOURCE_LIMIT_CLOSE_CODE ) {
		notifyTerminalClose();
	}
	return true;
}
