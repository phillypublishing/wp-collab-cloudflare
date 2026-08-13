import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createMetaBoxSuppressionController,
	getMetaBoxSuppressionUiState,
	listenForLegacyMetaBoxChanges,
} from '../src/meta-box-suppression.mjs';

test( 'hides the site-wide control from users without manage_options', () => {
	assert.deepEqual(
		getMetaBoxSuppressionUiState( {
			canManage: false,
			enabled: true,
			isDirty: false,
			isSaving: false,
		} ),
		{ visible: false }
	);
} );

test( 'shows administrators an explicit site-wide rendering and submission warning', () => {
	const state = getMetaBoxSuppressionUiState( {
		canManage: true,
		enabled: false,
		isDirty: false,
		isSaving: false,
	} );

	assert.equal( state.visible, true );
	assert.equal( state.disabled, false );
	assert.match( state.warning, /anyone on this site/iu );
	assert.match( state.warning, /render|appear/iu );
	assert.match( state.warning, /submit|save/iu );
	assert.match( state.warning, /third-party save handlers/iu );
} );

test( 'refuses policy changes while the post is dirty or saving', async () => {
	let apiCalls = 0;
	let reloads = 0;
	for ( const editorState of [
		{ isDirty: true, isSaving: false },
		{ isDirty: false, isSaving: true },
	] ) {
		const controller = createMetaBoxSuppressionController( {
			endpoint: '/wp-json/wp-collab-cf/v1/meta-box-suppression',
			getEditorState: () => editorState,
			apiFetch: async () => {
				apiCalls += 1;
			},
			reload: () => {
				reloads += 1;
			},
		} );

		await assert.rejects(
			controller.setEnabled( true ),
			/post is dirty or saving/iu
		);
	}
	assert.equal( apiCalls, 0 );
	assert.equal( reloads, 0 );
} );

test( 'saves an exact boolean then hard reloads', async () => {
	const requests = [];
	let reloads = 0;
	const controller = createMetaBoxSuppressionController( {
		endpoint: '/wp-json/wp-collab-cf/v1/meta-box-suppression',
		getEditorState: () => ( { isDirty: false, isSaving: false } ),
		apiFetch: async ( request ) => {
			requests.push( request );
			return { enabled: true };
		},
		reload: () => {
			reloads += 1;
		},
	} );

	assert.deepEqual( await controller.setEnabled( true ), {
		enabled: true,
		reloadDeferred: false,
	} );
	assert.deepEqual( requests, [
		{
			url: '/wp-json/wp-collab-cf/v1/meta-box-suppression',
			method: 'POST',
			data: { enabled: true },
		},
	] );
	assert.equal( reloads, 1 );
} );

test( 'surfaces REST errors without reloading', async () => {
	const expected = new Error( 'forbidden' );
	let reloads = 0;
	const controller = createMetaBoxSuppressionController( {
		endpoint: '/wp-json/wp-collab-cf/v1/meta-box-suppression',
		getEditorState: () => ( { isDirty: false, isSaving: false } ),
		apiFetch: async () => {
			throw expected;
		},
		reload: () => {
			reloads += 1;
		},
	} );

	await assert.rejects( controller.setEnabled( false ), expected );
	assert.equal( reloads, 0 );
} );

test( 'tracks input and change events only inside legacy meta box forms', () => {
	const listeners = new Map();
	const removed = [];
	const document = {
		defaultView: null,
		documentElement: {},
		addEventListener: ( event, callback, capture ) => {
			listeners.set( event, { callback, capture } );
		},
		removeEventListener: ( event, callback, capture ) => {
			removed.push( { event, callback, capture } );
		},
		querySelectorAll: () => [],
	};
	let dirtyEvents = 0;
	const stop = listenForLegacyMetaBoxChanges( document, () => {
		dirtyEvents += 1;
	} );

	assert.deepEqual( [ ...listeners.keys() ], [ 'input', 'change', 'load' ] );
	assert.equal( listeners.get( 'input' ).capture, true );
	listeners.get( 'input' ).callback( {
		target: { closest: () => ( {} ) },
	} );
	listeners.get( 'change' ).callback( {
		target: { closest: () => null },
	} );
	listeners.get( 'input' ).callback( { target: null } );
	assert.equal( dirtyEvents, 1 );

	stop();
	assert.deepEqual(
		removed.map( ( entry ) => ( {
			event: entry.event,
			capture: entry.capture,
			sameCallback:
				entry.callback === listeners.get( entry.event ).callback,
		} ) ),
		[
			{ event: 'input', capture: true, sameCallback: true },
			{ event: 'change', capture: true, sameCallback: true },
			{ event: 'load', capture: true, sameCallback: true },
		]
	);
} );

test( 'tracks edits inside existing same-origin legacy meta box iframes', () => {
	const iframeListeners = new Map();
	const removedIframeListeners = [];
	const iframeDocument = {
		addEventListener: ( event, callback, capture ) => {
			iframeListeners.set( event, { callback, capture } );
		},
		removeEventListener: ( event, callback, capture ) => {
			removedIframeListeners.push( { event, callback, capture } );
		},
	};
	const iframe = {
		closest: () => ( {} ),
		contentDocument: iframeDocument,
	};
	const document = {
		defaultView: null,
		documentElement: {},
		addEventListener: () => {},
		removeEventListener: () => {},
		querySelectorAll: () => [ iframe ],
	};
	let dirtyEvents = 0;
	const stop = listenForLegacyMetaBoxChanges( document, () => {
		dirtyEvents += 1;
	} );

	iframeListeners.get( 'input' ).callback();
	iframeListeners.get( 'change' ).callback();
	assert.equal( dirtyEvents, 2 );

	stop();
	assert.deepEqual(
		removedIframeListeners.map( ( entry ) => ( {
			event: entry.event,
			capture: entry.capture,
			sameCallback:
				entry.callback === iframeListeners.get( entry.event ).callback,
		} ) ),
		[
			{ event: 'input', capture: true, sameCallback: true },
			{ event: 'change', capture: true, sameCallback: true },
		]
	);
} );

test( 'defers reload when the editor changes during the REST request', async () => {
	let editorState = { isDirty: false, isSaving: false };
	let reloads = 0;
	const controller = createMetaBoxSuppressionController( {
		endpoint: '/wp-json/wp-collab-cf/v1/meta-box-suppression',
		getEditorState: () => editorState,
		apiFetch: async () => {
			editorState = { isDirty: true, isSaving: false };
			return { enabled: true };
		},
		reload: () => {
			reloads += 1;
		},
	} );

	assert.deepEqual( await controller.setEnabled( true ), {
		enabled: true,
		reloadDeferred: true,
	} );
	assert.equal( reloads, 0 );
} );
