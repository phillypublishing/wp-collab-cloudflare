import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import YProvider from 'y-partyserver/provider';
import * as Y from 'yjs';
import {
	createOutageReporter,
	createConnectionTelemetry,
} from '../src/outage-telemetry.mjs';

import {
	createProviderStatusBridge,
	handleConnectionClose,
} from '../src/connection-policy.mjs';

class RuntimeWebSocket extends EventTarget {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	CONNECTING = RuntimeWebSocket.CONNECTING;
	OPEN = RuntimeWebSocket.OPEN;
	CLOSING = RuntimeWebSocket.CLOSING;
	CLOSED = RuntimeWebSocket.CLOSED;
	binaryType = 'arraybuffer';
	readyState = RuntimeWebSocket.CONNECTING;

	constructor( url ) {
		super();
		this.url = String( url );
		this.createdAt = Date.now();
		RuntimeWebSocket.instances.push( this );
	}

	close( code = 1000, reason = '' ) {
		if ( this.readyState === RuntimeWebSocket.CLOSED ) {
			return;
		}
		this.fail( code, reason, true );
	}

	fail( code = 1006, reason = '', wasClean = false ) {
		if ( this.readyState === RuntimeWebSocket.CLOSED ) {
			return;
		}
		this.readyState = RuntimeWebSocket.CLOSED;
		const event = new Event( 'close' );
		Object.defineProperties( event, {
			code: { value: code },
			reason: { value: reason },
			wasClean: { value: wasClean },
		} );
		this.dispatchEvent( event );
	}

	open() {
		this.readyState = RuntimeWebSocket.OPEN;
		this.dispatchEvent( new Event( 'open' ) );
	}

	send() {}

	static instances = [];
}

async function waitForSocketCount( count, timeout = 2_000 ) {
	const deadline = Date.now() + timeout;
	while (
		RuntimeWebSocket.instances.length < count &&
		Date.now() < deadline
	) {
		await delay( 5 );
	}
	assert.equal( RuntimeWebSocket.instances.length, count );
	return RuntimeWebSocket.instances.at( -1 );
}

function createRuntimeProvider() {
	RuntimeWebSocket.instances = [];
	const document = new Y.Doc();
	const provider = new YProvider(
		'localhost:8787',
		'runtime-retry',
		document,
		{
			connect: false,
			disableBc: true,
			maxBackoffTime: 400,
			WebSocketPolyfill: RuntimeWebSocket,
		}
	);
	return { document, provider };
}

test( 'outage telemetry observes real provider close and sync without changing retry policy', async ( t ) => {
	const { document, provider } = createRuntimeProvider();
	const batches = [];
	const reporter = createOutageReporter( {
		send: async ( batch ) => batches.push( batch ),
		getContext: () => ( {
			postId: 302085,
			versions: {},
			online: true,
			visibility: 'visible',
		} ),
	} );
	const telemetry = createConnectionTelemetry(
		reporter,
		'postType/wp_block',
		248365
	);
	telemetry.attach( provider );
	const bridge = createProviderStatusBridge( provider, {
		onDestroy: () => telemetry.destroy(),
	} );
	t.after( () => {
		bridge.destroy();
		reporter.destroy();
		document.destroy();
	} );
	await provider.connect();
	const socket = await waitForSocketCount( 1 );
	socket.open();
	socket.fail();
	const replacement = await waitForSocketCount( 2 );
	replacement.open();
	// A real Yjs sync-step-2 message completes synchronization after socket open.
	const message = new Event( 'message' );
	Object.defineProperty( message, 'data', {
		value: Uint8Array.from( [ 0, 1, 2, 0, 0 ] ).buffer,
	} );
	replacement.dispatchEvent( message );
	await reporter.flush();
	assert.equal( provider.synced, true );
	assert.equal( provider.shouldConnect, true );
	const events = batches.flatMap( ( batch ) => batch.events );
	assert.ok(
		events.some(
			( event ) =>
				event.event === 'socket_closed' && event.closeCode === 1006
		)
	);
	assert.deepEqual(
		events.slice( -3 ).map( ( event ) => event.event ),
		[ 'socket_opened', 'sync_completed', 'outage_recovered' ]
	);
} );

test( 'real y-partyserver retries use bridged timing without an early pause', async ( t ) => {
	const { document, provider } = createRuntimeProvider();
	const bridge = createProviderStatusBridge( provider );
	const disconnected = [];
	bridge.on( 'status', ( status ) => {
		if ( status.status === 'disconnected' ) {
			disconnected.push( { ...status, observedAt: Date.now() } );
		}
	} );
	t.after( () => {
		bridge.destroy();
		document.destroy();
	} );

	await provider.connect();
	let socket = await waitForSocketCount( 1 );
	socket.open();
	await delay( 2_050 );

	for ( let count = 2; count <= 5; count += 1 ) {
		const closedAt = Date.now();
		socket.fail();
		socket = await waitForSocketCount( count );
		const expectedDelay = [ 100, 200, 400, 400 ][ count - 2 ];
		assert.equal( disconnected.at( -1 ).willAutoRetryInMs, expectedDelay );
		assert.ok(
			socket.createdAt >= closedAt + expectedDelay - 20,
			`replacement socket ${ count } opened before the ${ expectedDelay }ms retry delay`
		);
	}

	assert.deepEqual(
		disconnected.map( ( status ) => status.backgroundRetriesFailed ),
		[ false, false, false, false ]
	);

	socket.open();
	await delay( 2_050 );
	socket.fail();
	assert.deepEqual(
		{
			backgroundRetriesFailed:
				disconnected.at( -1 ).backgroundRetriesFailed,
			willAutoRetryInMs: disconnected.at( -1 ).willAutoRetryInMs,
		},
		{ backgroundRetriesFailed: false, willAutoRetryInMs: 100 }
	);
} );

test( 'rapid replacement socket failures remain background retries', async ( t ) => {
	const { document, provider } = createRuntimeProvider();
	const bridge = createProviderStatusBridge( provider );
	const disconnected = [];
	bridge.on( 'status', ( status ) => {
		if ( status.status === 'disconnected' ) {
			disconnected.push( status );
		}
	} );
	t.after( () => {
		bridge.destroy();
		document.destroy();
	} );

	await provider.connect();
	let socket = await waitForSocketCount( 1 );
	socket.open();
	await delay( 2_050 );

	for ( let count = 2; count <= 5; count += 1 ) {
		socket.fail();
		socket = await waitForSocketCount( count );
		socket.open();
	}

	assert.deepEqual(
		disconnected.map( ( status ) => status.backgroundRetriesFailed ),
		[ false, false, false, false ]
	);
} );

for ( const code of [ 4008, 1002, 1008 ] ) {
	test( `real y-partyserver does not retry terminal close ${ code }`, async ( t ) => {
		const { document, provider } = createRuntimeProvider();
		let notices = 0;
		provider.on( 'connection-close', ( event ) => {
			handleConnectionClose( event, provider, () => {
				notices += 1;
			} );
		} );
		const bridge = createProviderStatusBridge( provider );
		const statuses = [];
		bridge.on( 'status', ( status ) => statuses.push( status ) );
		t.after( () => {
			bridge.destroy();
			document.destroy();
		} );

		await provider.connect();
		const socket = await waitForSocketCount( 1 );
		socket.open();
		socket.fail( code );
		await delay( 150 );

		assert.equal( RuntimeWebSocket.instances.length, 1 );
		assert.equal( provider.shouldConnect, false );
		assert.deepEqual( statuses.at( -1 ), { status: 'disconnected' } );
		assert.equal( notices, code === 4008 ? 1 : 0 );
	} );
}
