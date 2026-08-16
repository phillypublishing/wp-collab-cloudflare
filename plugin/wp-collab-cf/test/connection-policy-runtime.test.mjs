import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import YProvider from 'y-partyserver/provider';
import * as Y from 'yjs';

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
	while ( RuntimeWebSocket.instances.length < count && Date.now() < deadline ) {
		await delay( 5 );
	}
	assert.equal( RuntimeWebSocket.instances.length, count );
	return RuntimeWebSocket.instances.at( -1 );
}

function createRuntimeProvider() {
	RuntimeWebSocket.instances = [];
	const document = new Y.Doc();
	const provider = new YProvider( 'localhost:8787', 'runtime-retry', document, {
		connect: false,
		disableBc: true,
		maxBackoffTime: 400,
		WebSocketPolyfill: RuntimeWebSocket,
	} );
	return { document, provider };
}

test( 'real y-partyserver retries use the bridged timing, threshold, and reset', async ( t ) => {
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
		assert.equal(
			disconnected.at( -1 ).willAutoRetryInMs,
			expectedDelay
		);
		assert.ok(
			socket.createdAt >= closedAt + expectedDelay - 20,
			`replacement socket ${ count } opened before the ${ expectedDelay }ms retry delay`
		);
	}

	assert.deepEqual(
		disconnected.map( ( status ) => status.backgroundRetriesFailed ),
		[ false, false, false, true ]
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

test( 'real y-partyserver counts replacement sockets that close before becoming stable', async ( t ) => {
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
		[ false, false, false, true ]
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
