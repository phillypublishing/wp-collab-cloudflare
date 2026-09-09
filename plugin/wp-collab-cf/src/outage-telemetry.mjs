/* global globalThis */
// Browser records are diagnostic claims, not authority for authentication.
const MAX_EVENTS = 50;
const UPLOAD_INTERVAL_MS = 15000;
const OUTAGE_THRESHOLD_MS = 10000;
const MAX_DURATION_MS = 604800000;
const EVENT_FIELDS = [
	'outageId',
	'objectType',
	'objectId',
	'connectionAttemptId',
	'closeCode',
	'retryCount',
	'durationMs',
	'httpStatus',
	'errorCode',
	'synced',
];

function bestEffort( callback ) {
	try {
		return callback();
	} catch {
		return undefined;
	}
}

/**
 * Keep a small timeline in memory. Only explicit flushes initiate uploads.
 *
 * @param {Object}   options              Injectable transport, editor context and clock.
 * @param {Function} options.send         Upload a bounded report.
 * @param {Function} options.getContext   Read editor and browser metadata.
 * @param {Function} options.now          Wall clock for cross-system correlation.
 * @param {Function} options.monotonic    Monotonic clock for durations.
 * @param {Function} options.uuid         Generate a random correlation UUID.
 * @param {Function} options.setTimeout   Schedule a flush or outage check.
 * @param {Function} options.clearTimeout Cancel a scheduled callback.
 */
export function createOutageReporter( {
	send,
	getContext,
	now = Date.now,
	monotonic = () => performance.now(),
	uuid = () => globalThis.crypto.randomUUID(),
	setTimeout: schedule = globalThis.setTimeout,
	clearTimeout: cancel = globalThis.clearTimeout,
} ) {
	const editorSessionId = uuid();
	const startedAt = monotonic();
	const affected = new Map();
	let events = [];
	let sequence = 0;
	let inFlight = null;
	let timer = null;
	let nextUploadAt = 0;
	let destroyed = false;
	const duration = ( start ) =>
		Math.min(
			MAX_DURATION_MS,
			Math.max( 0, Math.round( monotonic() - start ) )
		);
	const scheduleFlush = ( ms ) => {
		if ( timer !== null || destroyed ) {
			return;
		}
		timer = schedule( () => {
			timer = null;
			void flush();
		}, ms );
		timer?.unref?.();
	};
	const record = ( event, fields = {} ) =>
		bestEffort( () => {
			if ( destroyed ) {
				return;
			}
			const context = getContext();
			const row = {
				event,
				seq: ++sequence,
				at: now(),
				elapsedMs: duration( startedAt ),
				online: context.online === true,
				visibility:
					context.visibility === 'hidden' ? 'hidden' : 'visible',
			};
			for ( const key of EVENT_FIELDS ) {
				if ( fields[ key ] !== undefined ) {
					row[ key ] = fields[ key ];
				}
			}
			events.push( row );
			if ( events.length > MAX_EVENTS ) {
				events.shift();
			}
		} );
	function flush() {
		if ( destroyed || ! events.length ) {
			return Promise.resolve();
		}
		if ( inFlight ) {
			return inFlight;
		}
		if ( monotonic() < nextUploadAt ) {
			scheduleFlush( nextUploadAt - monotonic() );
			return Promise.resolve();
		}
		if ( timer !== null ) {
			cancel( timer );
			timer = null;
		}
		const batch = events.slice();
		nextUploadAt = monotonic() + UPLOAD_INTERVAL_MS;
		inFlight = Promise.resolve()
			.then( () => {
				const { postId: currentPostId, versions } = getContext();
				const postId = Number( currentPostId );
				// Editor initialization may not yet have supplied a persisted post ID.
				if ( ! Number.isSafeInteger( postId ) || postId < 1 ) {
					throw new Error( 'Editor not ready' );
				}
				return send( {
					editorSessionId,
					postId,
					versions,
					events: batch,
				} );
			} )
			.then( () => {
				const acknowledged = batch.at( -1 ).seq;
				events = events.filter( ( event ) => event.seq > acknowledged );
			} )
			.catch( () => {
				// Retain the bounded buffer, including sequence IDs for server deduplication.
				nextUploadAt = monotonic() + 30000;
			} )
			.finally( () => {
				inFlight = null;
				if ( events.length ) {
					scheduleFlush( Math.max( 0, nextUploadAt - monotonic() ) );
				}
			} );
		return inFlight;
	}
	return {
		editorSessionId,
		uuid,
		monotonic,
		duration,
		// Native browser timers must not receive this reporter as `this`.
		schedule: ( callback, ms ) => schedule( callback, ms ),
		cancel: ( timerId ) => cancel( timerId ),
		record,
		flush,
		affectedEntities: () => [ ...affected.values() ],
		setAffected: ( key, value ) =>
			value ? affected.set( key, value ) : affected.delete( key ),
		destroy: () => {
			destroyed = true;
			if ( timer !== null ) {
				cancel( timer );
			}
			events = [];
			affected.clear();
		},
	};
}

/**
 * Instrument one provider without altering its retry or connection policy.
 *
 * @param {Object}             reporter   Shared editor telemetry buffer and clock.
 * @param {string}             objectType Sync entity type.
 * @param {number|string|null} objectId   Entity ID, or null for a collection.
 */
export function createConnectionTelemetry( reporter, objectType, objectId ) {
	// Gutenberg also supplies persisted entity IDs as decimal strings.
	objectId = objectId === null ? null : Number( objectId );
	if (
		objectId !== null &&
		( ! Number.isSafeInteger( objectId ) || objectId < 1 )
	) {
		throw new Error( 'Unsupported telemetry entity ID' );
	}
	let connectionAttemptId;
	let attempts = 0;
	let outage = null;
	let timer = null;
	let provider;
	let stopped = false;
	const listeners = [];
	const key = reporter.uuid();
	const fields = () => ( {
		objectType,
		objectId,
		connectionAttemptId,
		retryCount: Math.max( 0, attempts - 1 ),
		...( outage ? { outageId: outage.id } : {} ),
	} );
	const record = ( event, extra ) =>
		reporter.record( event, { ...fields(), ...extra } );
	const clearTimer = () => {
		if ( timer !== null ) {
			reporter.cancel( timer );
			timer = null;
		}
	};
	const beginOutage = () => {
		if ( outage ) {
			return;
		}
		outage = { id: reporter.uuid(), startedAt: reporter.monotonic() };
		reporter.setAffected( key, fields() );
		record( 'outage_started' );
		timer = reporter.schedule( () => {
			timer = null;
			if ( ! stopped && outage ) {
				record( 'outage_threshold', {
					durationMs: reporter.duration( outage.startedAt ),
					synced: provider?.synced === true,
				} );
				void reporter.flush();
			}
		}, OUTAGE_THRESHOLD_MS );
		timer?.unref?.();
	};
	return {
		async credentials( request ) {
			// Failure of diagnostic bookkeeping must never prevent authentication.
			const startedAt = bestEffort( () => reporter.monotonic() );
			bestEffort( () => {
				connectionAttemptId = reporter.uuid();
				attempts++;
				record( 'credential_started' );
			} );
			try {
				const result = await request( {
					editorSessionId: reporter.editorSessionId,
					connectionAttemptId,
				} );
				bestEffort( () =>
					record( 'credential_succeeded', {
						durationMs: reporter.duration( startedAt ),
					} )
				);
				return result;
			} catch ( error ) {
				bestEffort( () => {
					const code =
						typeof error?.code === 'string' &&
						/^[a-zA-Z0-9_-]{1,64}$/.test( error.code )
							? error.code
							: 'unknown_error';
					const status = error?.data?.status;
					record( 'credential_failed', {
						durationMs: reporter.duration( startedAt ),
						errorCode: code,
						...( Number.isInteger( status ) &&
						status >= 400 &&
						status <= 599
							? { httpStatus: status }
							: {} ),
					} );
					beginOutage();
					void reporter.flush();
				} );
				throw error;
			}
		},
		attach( value ) {
			provider = value;
			const on = ( event, callback ) => {
				const safeCallback = ( ...args ) =>
					bestEffort( () => {
						if ( ! stopped ) {
							callback( ...args );
						}
					} );
				provider.on( event, safeCallback );
				listeners.push( [ event, safeCallback ] );
			};
			on( 'connection-close', ( event ) => {
				beginOutage();
				record( 'socket_closed', {
					closeCode: Number.isInteger( event.code )
						? event.code
						: 1006,
				} );
			} );
			on( 'connection-error', () => record( 'socket_error' ) );
			on( 'status', ( status ) => {
				if ( status.status === 'connected' ) {
					record( 'socket_opened' );
				}
			} );
			on( 'sync', ( synced ) => {
				if ( ! synced ) {
					return;
				}
				record( 'sync_completed', { synced: true } );
				if ( outage ) {
					record( 'outage_recovered', {
						durationMs: reporter.duration( outage.startedAt ),
					} );
					clearTimer();
					outage = null;
					attempts = 1;
					reporter.setAffected( key, null );
					void reporter.flush();
				}
			} );
		},
		destroy() {
			bestEffort( () => {
				stopped = true;
				clearTimer();
				for ( const [ event, callback ] of listeners ) {
					provider.off( event, callback );
				}
				record( 'provider_destroyed' );
				reporter.setAffected( key, null );
				if ( outage ) {
					void reporter.flush();
				}
			} );
		},
	};
}

/**
 * Observe the actual Gutenberg overlay, not an inferred connection pause.
 *
 * @param {Object}   options                  Browser observation dependencies.
 * @param {Document} options.document         Editor document containing the overlay.
 * @param {Function} options.MutationObserver Browser DOM observer constructor.
 * @param {Object}   options.reporter         Shared editor telemetry reporter.
 */
export function observeOutageModal( { document, MutationObserver, reporter } ) {
	const selector = '.editor-sync-connection-error-modal';
	let shown = false;
	let shownAt = 0;
	let entities = [];
	const inspect = () =>
		bestEffort( () => {
			const present = Boolean( document.querySelector( selector ) );
			if ( present === shown ) {
				return;
			}
			shown = present;
			if ( shown ) {
				shownAt = reporter.monotonic();
				entities = reporter.affectedEntities();
			}
			for ( const entity of entities.length ? entities : [ {} ] ) {
				reporter.record( shown ? 'modal_shown' : 'modal_hidden', {
					...entity,
					...( shown
						? {}
						: {
								durationMs: Math.min(
									MAX_DURATION_MS,
									Math.max(
										0,
										Math.round(
											reporter.monotonic() - shownAt
										)
									)
								),
						  } ),
				} );
			}
			void reporter.flush();
		} );
	const observer = new MutationObserver( ( mutations ) => {
		// Most editor DOM mutations have nothing to do with this overlay.
		if ( ! mutations?.length ) {
			inspect();
			return;
		}
		for ( const mutation of mutations ) {
			for ( const nodes of [
				mutation.addedNodes,
				mutation.removedNodes,
			] ) {
				for ( const node of nodes ) {
					if (
						node.matches?.( selector ) ||
						node.querySelector?.( selector )
					) {
						inspect();
						return;
					}
				}
			}
		}
	} );
	observer.observe( document.body, { childList: true, subtree: true } );
	inspect();
	return () => observer.disconnect();
}
