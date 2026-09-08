import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { before, after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import vm from 'node:vm';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as sync from 'y-protocols/sync';

const require = createRequire( import.meta.url );
let source;
let modules;
let output;

before( async () => {
	// Exercise the production alias and minifier, not Node's direct yjs import.
	process.env.NODE_ENV = 'production';
	const config = require( '../webpack.config.js' );
	const webpack = require( 'webpack' );
	mkdirSync( 'build', { recursive: true } );
	output = mkdtempSync( join( process.cwd(), 'build/provider-test-' ) );
	const compiler = webpack( {
		...config,
		mode: 'production',
		output: { ...config.output, path: output },
	} );
	try {
		const stats = await new Promise( ( resolve, reject ) => {
			compiler.run( ( error, result ) =>
				error ? reject( error ) : resolve( result )
			);
		} );
		assert.equal(
			stats.hasErrors(),
			false,
			stats.toString( { all: false, errors: true } )
		);
		modules = JSON.stringify(
			stats.toJson( { all: false, modules: true, nestedModules: true } )
		);
		source = readFileSync( join( output, 'index.js' ), 'utf8' );
	} finally {
		await new Promise( ( resolve, reject ) =>
			compiler.close( ( error ) =>
				error ? reject( error ) : resolve()
			)
		);
	}
} );

after( () => {
	if ( output ) {
		rmSync( output, { recursive: true, force: true } );
	}
} );

function loadProvider( t, legacyY ) {
	const sockets = [];
	const credentials = [];
	const errors = [];
	const timers = new Set();
	class Socket extends EventTarget {
		static OPEN = 1;
		OPEN = 1;
		readyState = 0;
		messages = [];
		constructor() {
			super();
			sockets.push( this );
		}
		open() {
			this.readyState = 1;
			this.dispatchEvent( new Event( 'open' ) );
		}
		send( bytes ) {
			this.messages.push( Uint8Array.from( bytes ) );
		}
		receive( bytes ) {
			const event = new Event( 'message' );
			Object.defineProperty( event, 'data', { value: bytes } );
			this.dispatchEvent( event );
		}
		close() {
			this.readyState = 3;
			this.dispatchEvent( new Event( 'close' ) );
		}
	}
	let creator;
	const wp = {
		hooks: {
			addFilter: ( name, namespace, callback ) => {
				if ( name === 'sync.providers' ) {
					[ creator ] = callback( [] );
				}
			},
			hasFilter: () => false,
		},
		apiFetch: async ( request ) => {
			credentials.push( request.data );
			return { room: 'test-room', token: 'test-token' };
		},
		components: {},
		editor: {},
		element: {},
		plugins: {},
		i18n: {},
		data: {},
		...( legacyY ? { sync: { Y: legacyY } } : {} ),
	};
	const context = {
		wp,
		wpCollabCf: {
			wsUrl: 'wss://example.invalid',
			tokenUrl: 'https://example.invalid/token',
		},
		addEventListener() {},
		removeEventListener() {},
		WebSocket: Socket,
		BroadcastChannel: class {
			postMessage() {}
			close() {}
		},
		console: { ...console, error: ( ...args ) => errors.push( args ) },
		crypto: webcrypto,
		TextEncoder,
		TextDecoder,
		URL,
		URLSearchParams,
		Uint8Array,
		ArrayBuffer,
		setTimeout: ( callback, ms ) => {
			const timer = setTimeout( callback, ms );
			timers.add( timer );
			return timer;
		},
		clearTimeout,
		setInterval: ( callback, ms ) => {
			const timer = setInterval( callback, ms );
			timers.add( timer );
			return timer;
		},
		clearInterval,
	};
	context.window = context;
	t.after( () => {
		for ( const timer of timers ) {
			clearTimeout( timer );
		}
	} );
	vm.runInNewContext( source, context );
	assert.equal( typeof creator, 'function' );
	return { creator, wp, sockets, credentials, errors };
}

function message( write ) {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint( encoder, 0 );
	write( encoder );
	return encoding.toUint8Array( encoder );
}

test( 'production bundle aliases Yjs instead of including a second implementation', () => {
	assert.match( modules, /src\/yjs-shim\.js/ );
	assert.doesNotMatch( modules, /node_modules\/yjs\// );
} );

for ( const mode of [
	'option',
	'legacy',
	'both',
	'late-legacy',
	'collection',
] ) {
	test( `production provider completes Yjs sync using ${ mode }`, async ( t ) => {
		const staleY = new Proxy(
			{},
			{
				get() {
					throw new Error(
						'Legacy Yjs must not be used when the option is present'
					);
				},
			}
		);
		let legacyY;
		if ( mode === 'legacy' ) {
			legacyY = Y;
		} else if ( mode === 'both' ) {
			legacyY = staleY;
		}
		const runtime = loadProvider( t, legacyY );
		if ( mode === 'late-legacy' ) {
			runtime.wp.sync = { Y };
		}
		const doc = new Y.Doc();
		const peer = new Y.Doc();
		const awareness =
			mode === 'collection' ? undefined : new Awareness( doc );
		let provider = null;
		t.after( () => {
			provider?.destroy();
			awareness?.destroy();
			doc.destroy();
			peer.destroy();
		} );
		const options = {
			objectType: 'postType/post',
			objectId: mode === 'collection' ? null : 123,
			ydoc: doc,
			awareness,
			...( [ 'option', 'both', 'collection' ].includes( mode )
				? { Y }
				: {} ),
		};
		provider = await runtime.creator( options );
		// The creator starts an asynchronous connect; bound the socket wait.
		for (
			let attempt = 0;
			! runtime.sockets.length && attempt < 20;
			attempt++
		) {
			await delay( 5 );
		}
		assert.equal(
			runtime.credentials.length,
			1,
			JSON.stringify( runtime.errors )
		);
		assert.equal( runtime.credentials[ 0 ].objectId, options.objectId );
		assert.equal(
			runtime.sockets.length,
			1,
			JSON.stringify( runtime.errors )
		);
		const socket = runtime.sockets[ 0 ];
		socket.open();
		assert.deepEqual(
			socket.messages[ 0 ],
			message( ( encoder ) => sync.writeSyncStep1( encoder, doc ) )
		);

		peer.getText( 'content' ).insert( 0, 'from peer' );
		socket.receive(
			message( ( encoder ) => sync.writeSyncStep2( encoder, peer ) )
		);
		assert.equal( doc.getText( 'content' ).toString(), 'from peer' );

		const beforeStep1 = socket.messages.length;
		socket.receive(
			message( ( encoder ) => sync.writeSyncStep1( encoder, peer ) )
		);
		assert.deepEqual(
			socket.messages[ beforeStep1 ],
			message( ( encoder ) =>
				sync.writeSyncStep2( encoder, doc, Y.encodeStateVector( peer ) )
			)
		);

		let update;
		peer.once( 'update', ( bytes ) => {
			update = bytes;
		} );
		peer.getText( 'content' ).insert( 9, ' updated' );
		socket.receive(
			message( ( encoder ) => sync.writeUpdate( encoder, update ) )
		);
		assert.equal(
			doc.getText( 'content' ).toString(),
			'from peer updated'
		);

		doc.getText( 'content' ).insert( 0, 'local ' );
		const decoder = decoding.createDecoder( socket.messages.at( -1 ) );
		assert.equal( decoding.readVarUint( decoder ), 0 );
		sync.readSyncMessage( decoder, encoding.createEncoder(), peer, null );
		assert.equal(
			peer.getText( 'content' ).toString(),
			'local from peer updated'
		);
		assert.deepEqual( runtime.errors, [] );
	} );
}

test( 'missing Yjs returns an inert provider before credentials or sockets', async ( t ) => {
	const runtime = loadProvider( t );
	const doc = new Y.Doc();
	t.after( () => doc.destroy() );
	const provider = await runtime.creator( {
		objectType: 'postType/post',
		objectId: 123,
		ydoc: doc,
	} );
	provider.on( 'status', () => {} );
	provider.destroy();
	assert.equal( runtime.credentials.length, 0 );
	assert.equal( runtime.sockets.length, 0 );
	assert.equal( runtime.errors.length, 1 );
	assert.match( runtime.errors[ 0 ][ 0 ], /Y.*provider option.*wp\.sync\.Y/ );
} );
