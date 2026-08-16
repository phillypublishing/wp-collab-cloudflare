import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import {
	createProviderStatusBridge,
	handleConnectionClose,
} from '../src/connection-policy.mjs';

function createProviderDouble() {
	const listeners = new Map();
	let destroys = 0;

	return {
		maxBackoffTime: 2_500,
		marker: 'provider-state',
		shouldConnect: true,
		wsUnsuccessfulReconnects: 0,
		wsconnected: true,
		destroy: () => {
			destroys += 1;
		},
		destroyCount: () => destroys,
		emit: ( event, values ) => {
			for ( const callback of listeners.get( event ) || [] ) {
				callback( ...values );
			}
		},
		listenerCount: ( event ) => ( listeners.get( event ) || [] ).length,
		off: ( event, callback ) => {
			const callbacks = listeners.get( event ) || [];
			listeners.set(
				event,
				callbacks.filter( ( candidate ) => candidate !== callback )
			);
		},
		on: ( event, callback ) => {
			const callbacks = listeners.get( event ) || [];
			callbacks.push( callback );
			listeners.set( event, callbacks );
		},
		once( event, callback ) {
			const onceCallback = ( ...args ) => {
				this.off( event, onceCallback );
				callback( ...args );
			};
			this.on( event, onceCallback );
		},
		readMarker() {
			return this.marker;
		},
	};
}

test( 'resource-limit closes stop reconnecting and notify the editor', () => {
	let disconnects = 0;
	let notices = 0;
	const handled = handleConnectionClose(
		{ code: 4008 },
		{
			disconnect: () => {
				disconnects += 1;
			},
		},
		() => {
			notices += 1;
		}
	);

	assert.equal( handled, true );
	assert.equal( disconnects, 1 );
	assert.equal( notices, 1 );
} );

for ( const code of [ 1002, 1008 ] ) {
	test( `terminal WebSocket close ${ code } stops reconnecting without a resource notice`, () => {
		let disconnects = 0;
		let notices = 0;
		const handled = handleConnectionClose(
			{ code },
			{
				disconnect: () => {
					disconnects += 1;
				},
			},
			() => {
				notices += 1;
			}
		);

		assert.equal( handled, true );
		assert.equal( disconnects, 1 );
		assert.equal( notices, 0 );
	} );
}

test( 'session timeout remains reconnectable', () => {
	let disconnects = 0;
	let notices = 0;
	const handled = handleConnectionClose(
		{ code: 4001 },
		{
			disconnect: () => {
				disconnects += 1;
			},
		},
		() => {
			notices += 1;
		}
	);

	assert.equal( handled, false );
	assert.equal( disconnects, 0 );
	assert.equal( notices, 0 );
} );

test( 'session timeout reports an automatic retry until reconnected', () => {
	const provider = createProviderDouble();
	const bridge = createProviderStatusBridge( provider );
	const statuses = [];
	bridge.on( 'status', ( status ) => statuses.push( status ) );

	provider.emit( 'connection-close', [ { code: 4001 } ] );
	provider.emit( 'status', [ { status: 'disconnected' } ] );
	provider.emit( 'status', [ { status: 'connecting' } ] );
	provider.emit( 'status', [ { status: 'connected' } ] );

	assert.deepEqual( statuses, [
		{
			status: 'disconnected',
			willAutoRetryInMs: 100,
			backgroundRetriesFailed: false,
		},
		{ status: 'connecting' },
		{ status: 'connected' },
	] );

	bridge.destroy();
	assert.equal( provider.destroyCount(), 1 );
} );

test( 'generic transient closes report exact provider retry timing and threshold', () => {
	const provider = createProviderDouble();
	const bridge = createProviderStatusBridge( provider );
	const statuses = [];
	bridge.on( 'status', ( status ) => statuses.push( status ) );

	provider.emit( 'connection-close', [ { code: 1006 } ] );
	provider.emit( 'status', [ { status: 'disconnected' } ] );
	provider.wsconnected = false;
	for ( const unsuccessfulReconnects of [ 0, 1, 2 ] ) {
		provider.wsUnsuccessfulReconnects = unsuccessfulReconnects;
		provider.emit( 'connection-close', [ { code: 1006 } ] );
	}

	assert.deepEqual( statuses, [
		{
			status: 'disconnected',
			willAutoRetryInMs: 100,
			backgroundRetriesFailed: false,
		},
		{
			status: 'disconnected',
			willAutoRetryInMs: 200,
			backgroundRetriesFailed: false,
		},
		{
			status: 'disconnected',
			willAutoRetryInMs: 400,
			backgroundRetriesFailed: false,
		},
		{
			status: 'disconnected',
			willAutoRetryInMs: 800,
			backgroundRetriesFailed: true,
		},
	] );
} );

test( 'a stable reconnect resets the generic retry failure count', async () => {
	const provider = createProviderDouble();
	const bridge = createProviderStatusBridge( provider );
	const statuses = [];
	bridge.on( 'status', ( status ) => statuses.push( status ) );

	provider.wsconnected = false;
	for ( const unsuccessfulReconnects of [ 0, 1, 2 ] ) {
		provider.wsUnsuccessfulReconnects = unsuccessfulReconnects;
		provider.emit( 'connection-close', [ { code: 1006 } ] );
	}
	provider.wsconnected = true;
	provider.wsUnsuccessfulReconnects = 0;
	provider.emit( 'status', [ { status: 'connected' } ] );
	await delay( 2_050 );
	provider.emit( 'connection-close', [ { code: 1006 } ] );

	assert.deepEqual( statuses.at( -1 ), {
		status: 'disconnected',
		willAutoRetryInMs: 100,
		backgroundRetriesFailed: false,
	} );
	bridge.destroy();
} );

for ( const code of [ 4008, 1002, 1008 ] ) {
	test( `terminal close ${ code } emits no retry metadata`, () => {
		const provider = createProviderDouble();
		const bridge = createProviderStatusBridge( provider );
		const statuses = [];
		bridge.on( 'status', ( status ) => statuses.push( status ) );

		provider.emit( 'connection-close', [ { code } ] );
		provider.emit( 'status', [ { status: 'disconnected' } ] );

		assert.deepEqual( statuses, [ { status: 'disconnected' } ] );
	} );
}

test( 'status listeners use the provider snapshot dispatch contract', () => {
	const provider = createProviderDouble();
	const bridge = createProviderStatusBridge( provider );
	const calls = [];
	const addedDuringDispatch = () => calls.push( 'added' );
	const removedDuringDispatch = () => calls.push( 'removed' );
	bridge.on( 'status', () => {
		calls.push( 'first' );
		bridge.off( 'status', removedDuringDispatch );
		bridge.on( 'status', addedDuringDispatch );
	} );
	bridge.on( 'status', removedDuringDispatch );

	provider.emit( 'status', [ { status: 'connected' } ] );
	assert.deepEqual( calls, [ 'first', 'removed' ] );

	provider.emit( 'status', [ { status: 'connected' } ] );
	assert.deepEqual( calls, [ 'first', 'removed', 'first', 'added' ] );
	bridge.destroy();
} );

test( 'one-shot status listeners receive the bridged session retry', () => {
	const provider = createProviderDouble();
	const bridge = createProviderStatusBridge( provider );
	const statuses = [];
	bridge.once( 'status', ( status ) => statuses.push( status ) );

	provider.emit( 'connection-close', [ { code: 4001 } ] );
	provider.emit( 'status', [ { status: 'disconnected' } ] );
	provider.emit( 'status', [ { status: 'connecting' } ] );

	assert.deepEqual( statuses, [
		{
			status: 'disconnected',
			willAutoRetryInMs: 100,
			backgroundRetriesFailed: false,
		},
	] );
} );

test( 'the facade preserves one listener pair and detaches once on destroy', () => {
	const provider = createProviderDouble();
	const bridge = createProviderStatusBridge( provider );
	const statuses = [];
	bridge.on( 'status', ( status ) => statuses.push( status ) );
	assert.equal( provider.listenerCount( 'connection-close' ), 1 );
	assert.equal( provider.listenerCount( 'status' ), 1 );

	assert.equal( bridge.readMarker(), 'provider-state' );
	bridge.marker = 'updated-through-facade';
	assert.equal( provider.marker, 'updated-through-facade' );

	bridge.destroy();
	bridge.destroy();
	provider.emit( 'connection-close', [ { code: 4001 } ] );
	provider.emit( 'status', [ { status: 'disconnected' } ] );

	assert.deepEqual( statuses, [] );
	assert.equal( provider.destroyCount(), 1 );
	assert.equal( provider.listenerCount( 'connection-close' ), 0 );
	assert.equal( provider.listenerCount( 'status' ), 0 );
} );
