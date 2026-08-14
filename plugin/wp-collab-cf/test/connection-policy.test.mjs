import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createProviderStatusBridge,
	handleConnectionClose,
} from '../src/connection-policy.mjs';

function createProviderDouble() {
	const listeners = new Map();
	let destroys = 0;

	return {
		marker: 'provider-state',
		destroy: () => {
			destroys += 1;
		},
		destroyCount: () => destroys,
		emit: ( event, values ) => {
			for ( const callback of listeners.get( event ) || [] ) {
				callback( ...values );
			}
		},
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
	provider.emit( 'status', [ { status: 'disconnected' } ] );

	assert.deepEqual( statuses, [
		{ status: 'disconnected', willAutoRetryInMs: 100 },
		{ status: 'connecting' },
		{ status: 'connected' },
		{ status: 'disconnected' },
	] );

	bridge.destroy();
	assert.equal( provider.destroyCount(), 1 );
} );

test( 'non-expiry closes retain their original disconnected status', () => {
	const provider = createProviderDouble();
	const bridge = createProviderStatusBridge( provider );
	const statuses = [];
	bridge.on( 'status', ( status ) => statuses.push( status ) );

	provider.emit( 'connection-close', [ { code: 4008 } ] );
	provider.emit( 'status', [
		{
			status: 'disconnected',
			error: { code: 'document-size-limit-exceeded' },
		},
	] );

	assert.deepEqual( statuses, [
		{
			status: 'disconnected',
			error: { code: 'document-size-limit-exceeded' },
		},
	] );
} );

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
		{ status: 'disconnected', willAutoRetryInMs: 100 },
	] );
} );

test( 'the facade preserves provider methods and detaches on destroy', () => {
	const provider = createProviderDouble();
	const bridge = createProviderStatusBridge( provider );
	const statuses = [];
	bridge.on( 'status', ( status ) => statuses.push( status ) );

	assert.equal( bridge.readMarker(), 'provider-state' );
	bridge.marker = 'updated-through-facade';
	assert.equal( provider.marker, 'updated-through-facade' );

	bridge.destroy();
	provider.emit( 'connection-close', [ { code: 4001 } ] );
	provider.emit( 'status', [ { status: 'disconnected' } ] );

	assert.deepEqual( statuses, [] );
	assert.equal( provider.destroyCount(), 1 );
} );
