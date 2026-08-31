export const RESOURCE_LIMIT_CLOSE_CODE = 4008;
export const SESSION_TIMEOUT_CLOSE_CODE = 4001;

const PROTOCOL_ERROR_CLOSE_CODE = 1002;
const POLICY_VIOLATION_CLOSE_CODE = 1008;
const CONNECTION_STABLE_RESET_DELAY_MS = 2_000;
export const CONNECTION_OUTAGE_THRESHOLD_MS = 10_000;

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
 * retry delay mirrors y-partyserver's exponential backoff exactly. Gutenberg
 * receives its pause signal only after a continuous ten-second outage, rather
 * than after a fixed number of fast failures.
 *
 * @param {{
 *   destroy: () => void,
 *   off: (event: string, callback: (value: unknown) => void) => void,
 *   on: (event: string, callback: (value: any) => void) => void,
 *   once: (event: string, callback: (value: any) => void) => void
 * }} provider y-partyserver provider.
 * @param {{
 *   clearTimeout?: (timer: any) => void,
 *   now?: () => number,
 *   setTimeout?: (callback: () => void, milliseconds: number) => any,
 *   publishRetryableDisconnects?: boolean
 * }} options Injectable clock and downstream retry-failure policy.
 * @return {typeof provider} A transparent provider facade with bridged statuses.
 */
export function createProviderStatusBridge( provider, options = {} ) {
	const clearScheduledTimeout = options.clearTimeout || clearTimeout;
	const now = options.now || Date.now;
	const scheduleTimeout = options.setTimeout || setTimeout;
	const publishRetryableDisconnects =
		options.publishRetryableDisconnects !== false;
	const boundMethods = new Map();
	const listeners = new Set();
	let connectionStableTimer = null;
	let destroyed = false;
	let lastRetryDelayMs = null;
	let outageFailureTimer = null;
	let outageStartedAt = null;
	let suppressNextDisconnected = false;
	const emitStatus = ( status ) => {
		for ( const listener of [ ...listeners ] ) {
			listener( status );
		}
	};
	const clearConnectionStableTimer = () => {
		if ( connectionStableTimer !== null ) {
			clearScheduledTimeout( connectionStableTimer );
			connectionStableTimer = null;
		}
	};
	const clearOutageFailureTimer = () => {
		if ( outageFailureTimer !== null ) {
			clearScheduledTimeout( outageFailureTimer );
			outageFailureTimer = null;
		}
	};
	const resetOutage = () => {
		clearOutageFailureTimer();
		lastRetryDelayMs = null;
		outageStartedAt = null;
	};
	const outageElapsedMs = () =>
		outageStartedAt === null
			? 0
			: Math.max( 0, now() - outageStartedAt );
	const scheduleOutageFailure = () => {
		outageFailureTimer = scheduleTimeout( () => {
			outageFailureTimer = null;
			if (
				destroyed ||
				outageStartedAt === null ||
				provider.wsconnected === true ||
				lastRetryDelayMs === null
			) {
				return;
			}
			emitStatus( {
				status: 'disconnected',
				willAutoRetryInMs: lastRetryDelayMs,
				backgroundRetriesFailed: true,
			} );
		}, CONNECTION_OUTAGE_THRESHOLD_MS );
		if ( typeof outageFailureTimer?.unref === 'function' ) {
			outageFailureTimer.unref();
		}
	};

	const onConnectionClose = ( event ) => {
		const retryable = ! isTerminalClose( event.code );
		clearConnectionStableTimer();
		const providerFailedRetries =
			provider.wsUnsuccessfulReconnects +
			( provider.wsconnected === false ? 1 : 0 );
		suppressNextDisconnected =
			provider.wsconnected === true || ! publishRetryableDisconnects;
		if ( ! retryable ) {
			resetOutage();
			emitStatus( { status: 'disconnected' } );
			return;
		}
		if ( ! publishRetryableDisconnects ) {
			resetOutage();
			return;
		}

		const outageJustStarted = outageStartedAt === null;
		if ( outageJustStarted ) {
			outageStartedAt = now();
		}
		lastRetryDelayMs = Math.min(
			2 ** providerFailedRetries * 100,
			provider.maxBackoffTime
		);
		if ( outageJustStarted ) {
			scheduleOutageFailure();
		}
		emitStatus( {
			status: 'disconnected',
			willAutoRetryInMs: lastRetryDelayMs,
			backgroundRetriesFailed:
				outageElapsedMs() >= CONNECTION_OUTAGE_THRESHOLD_MS,
		} );
	};
	const onStatus = ( status ) => {
		if (
			status.status === 'disconnected' &&
			( suppressNextDisconnected || ! publishRetryableDisconnects )
		) {
			suppressNextDisconnected = false;
			return;
		}

		emitStatus( status );

		if ( status.status === 'connected' ) {
			clearConnectionStableTimer();
			connectionStableTimer = scheduleTimeout( () => {
				connectionStableTimer = null;
				resetOutage();
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
			resetOutage();
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
