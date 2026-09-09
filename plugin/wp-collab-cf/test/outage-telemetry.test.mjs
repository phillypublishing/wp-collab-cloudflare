import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
	createOutageReporter,
	createConnectionTelemetry,
	observeOutageModal,
} from '../src/outage-telemetry.mjs';

function fixture( send = async () => {}, context = {} ) {
	let time = 0;
	let id = 0;
	const timers = new Map();
	const reporter = createOutageReporter( {
		send,
		getContext: () => ( {
			postId: 302085,
			versions: { plugin: '0.5.13' },
			online: true,
			visibility: 'visible',
			...context,
		} ),
		now: () => 1788712247000 + time,
		monotonic: () => time,
		uuid: () =>
			`00000000-0000-4000-8000-${ String( ++id ).padStart( 12, '0' ) }`,
		// Browser timers reject a reporter object as their receiver. Arrow
		// functions hid that failure in the original fixture.
		setTimeout( fn, ms ) {
			assert.equal(
				this,
				undefined,
				'timer must be called without a receiver'
			);
			const key = ++id;
			timers.set( key, { fn, due: time + ms } );
			return key;
		},
		clearTimeout( key ) {
			assert.equal(
				this,
				undefined,
				'timer must be cleared without a receiver'
			);
			timers.delete( key );
		},
	} );
	return {
		reporter,
		advance: ( ms ) => {
			time += ms;
			for ( const [ key, timer ] of [ ...timers ] ) {
				if ( timer.due <= time ) {
					timers.delete( key );
					timer.fn();
				}
			}
		},
	};
}

test( 'decimal string IDs produce reports accepted by the numeric endpoint schema', async () => {
	const batches = [];
	const { reporter } = fixture( async ( data ) => batches.push( data ), {
		postId: '302085',
	} );
	const telemetry = createConnectionTelemetry(
		reporter,
		'postType/wp_block',
		'248365'
	);
	await telemetry.credentials( async () => ( {} ) );
	await reporter.flush();
	assert.equal( batches[ 0 ].postId, 302085 );
	assert.equal( batches[ 0 ].events[ 0 ].objectId, 248365 );
	telemetry.destroy();
	reporter.destroy();
} );

test( 'outage reports preserve browser close, recovery and sync as distinct milestones', async () => {
	const batches = [];
	const { reporter, advance } = fixture( async ( data ) =>
		batches.push( data )
	);
	const connection = createConnectionTelemetry(
		reporter,
		'postType/wp_block',
		248365
	);
	await connection.credentials( async ( trace ) => {
		assert.ok( trace.editorSessionId );
		assert.ok( trace.connectionAttemptId );
		return { token: 'secret-not-for-logs' };
	} );
	const provider = new EventEmitter();
	connection.attach( provider );
	provider.emit( 'status', { status: 'connected' } );
	provider.emit( 'sync', true );
	provider.emit( 'connection-close', {
		code: 1006,
		reason: 'secret-not-for-logs',
	} );
	advance( 10000 );
	await reporter.flush();
	advance( 34000 );
	provider.emit( 'status', { status: 'connected' } );
	advance( 50 );
	provider.emit( 'sync', true );
	await reporter.flush();
	const events = batches.flatMap( ( b ) => b.events );
	assert.equal(
		events.find( ( e ) => e.event === 'socket_closed' )?.closeCode,
		1006
	);
	assert.ok( events.some( ( e ) => e.event === 'outage_threshold' ) );
	assert.equal(
		events.find( ( e ) => e.event === 'outage_recovered' ).durationMs,
		44050
	);
	assert.equal( events.at( -1 ).objectId, 248365 );
	assert.ok( ! JSON.stringify( batches ).includes( 'secret-not-for-logs' ) );
	connection.destroy();
	assert.equal( provider.listenerCount( 'sync' ), 0 );
	reporter.destroy();
} );

test( 'failed uploads retain bounded events and retry without blocking editing', async () => {
	let attempts = 0;
	const batches = [];
	const { reporter, advance } = fixture( async ( data ) => {
		if ( attempts++ === 0 ) {
			throw new Error( 'offline' );
		}
		batches.push( data );
	} );
	for ( let i = 0; i < 80; i++ ) {
		reporter.record( 'socket_error' );
	}
	await reporter.flush();
	advance( 30000 );
	await reporter.flush();
	assert.equal( batches.length, 1 );
	assert.equal( batches[ 0 ].events.length, 50 );
	assert.equal( batches[ 0 ].events.at( -1 ).seq, 80 );
	reporter.destroy();
} );

test( 'destroying a provider during an outage cancels its reporting and removes affected context', async () => {
	const batches = [];
	const { reporter, advance } = fixture( async ( data ) =>
		batches.push( data )
	);
	const telemetry = createConnectionTelemetry(
		reporter,
		'postType/post',
		302085
	);
	await telemetry.credentials( async () => ( {} ) );
	const provider = new EventEmitter();
	telemetry.attach( provider );
	provider.emit( 'connection-close', { code: 1006 } );
	assert.equal( reporter.affectedEntities().length, 1 );
	telemetry.destroy();
	assert.equal( reporter.affectedEntities().length, 0 );
	assert.deepEqual( provider.eventNames(), [] );
	await reporter.flush();
	advance( 30000 );
	provider.emit( 'connection-close', { code: 1006 } );
	provider.emit( 'sync', true );
	await reporter.flush();
	const events = batches.flatMap( ( batch ) => batch.events );
	assert.equal(
		events.filter( ( event ) => event.event === 'provider_destroyed' )
			.length,
		1
	);
	assert.equal(
		events.filter( ( event ) => event.event === 'outage_started' ).length,
		1
	);
	assert.equal(
		events.some( ( event ) => event.event === 'outage_threshold' ),
		false
	);
	assert.equal(
		events.some( ( event ) => event.event === 'outage_recovered' ),
		false
	);
	reporter.destroy();
} );

test( 'events arriving during upload survive its acknowledgment', async () => {
	let finish;
	const batches = [];
	const { reporter, advance } = fixture( ( data ) => {
		batches.push( data );
		return batches.length === 1
			? new Promise( ( resolve ) => {
					finish = resolve;
			  } )
			: Promise.resolve();
	} );
	reporter.record( 'modal_shown' );
	const first = reporter.flush();
	await Promise.resolve();
	reporter.record( 'modal_hidden' );
	finish();
	await first;
	advance( 15000 );
	await reporter.flush();
	assert.deepEqual(
		batches.map( ( b ) => b.events.map( ( e ) => e.event ) ),
		[ [ 'modal_shown' ], [ 'modal_hidden' ] ]
	);
	reporter.destroy();
} );

test( 'modal observer logs actual presence transitions without polling or counting replacements twice', () => {
	const calls = [];
	let present = false;
	let callback;
	let disconnected = false;
	const stop = observeOutageModal( {
		document: { body: {}, querySelector: () => ( present ? {} : null ) },
		MutationObserver: class {
			constructor( cb ) {
				callback = cb;
			}
			observe() {}
			disconnect() {
				disconnected = true;
			}
		},
		reporter: {
			record: ( ...args ) => calls.push( args ),
			flush() {},
			monotonic: () => 50,
			affectedEntities: () => [],
		},
	} );
	present = true;
	callback();
	callback();
	present = false;
	callback();
	assert.deepEqual(
		calls.map( ( c ) => c[ 0 ] ),
		[ 'modal_shown', 'modal_hidden' ]
	);
	stop();
	assert.equal( disconnected, true );
} );

test( 'credential results and exceptions survive failing diagnostic callbacks', async () => {
	const { reporter } = fixture();
	reporter.record = () => {
		throw new Error( 'logger unavailable' );
	};
	const telemetry = createConnectionTelemetry(
		reporter,
		'postType/post',
		302085
	);
	const result = { token: 'not logged' };
	assert.equal( await telemetry.credentials( async () => result ), result );
	const error = new Error( 'original auth failure' );
	await assert.rejects(
		telemetry.credentials( async () => {
			throw error;
		} ),
		( observed ) => observed === error
	);
	telemetry.destroy();
	reporter.destroy();
} );
