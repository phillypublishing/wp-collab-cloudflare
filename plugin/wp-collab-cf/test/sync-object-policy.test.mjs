import assert from 'node:assert/strict';
import test from 'node:test';

import { isSupportedSyncObject } from '../src/sync-object-policy.mjs';

test( 'accepts Gutenberg collection shapes generically', () => {
	assert.equal( isSupportedSyncObject( 'root/comment', null ), true );
	assert.equal( isSupportedSyncObject( 'root/menuItem', null ), true );
	assert.equal( isSupportedSyncObject( 'root/wpCollabFixture', null ), true );
	assert.equal( isSupportedSyncObject( 'taxonomy/category', null ), true );
	assert.equal( isSupportedSyncObject( 'postType/page', null ), true );
	assert.equal( isSupportedSyncObject( 'acme/reviewQueue', null ), true );
	assert.equal(
		isSupportedSyncObject( `r/${ 'a'.repeat( 126 ) }`, null ),
		true
	);
} );

test( 'preserves positive post entity support', () => {
	assert.equal( isSupportedSyncObject( 'postType/post', 12 ), true );
	assert.equal( isSupportedSyncObject( 'postType/customType', '42' ), true );
} );

test( 'rejects malformed types and unsupported non-collection entities', () => {
	for ( const [ objectType, objectId ] of [
		[ 'root/comment', 1 ],
		[ 'taxonomy/category', 1 ],
		[ 'root/comment/extra', null ],
		[ 'root/comment.extra', null ],
		[ 'root/comment', 'collection' ],
		[ 'postType/post', 0 ],
		[ 'postType/post', -1 ],
		[ `r/${ 'a'.repeat( 127 ) }`, null ],
	] ) {
		assert.equal( isSupportedSyncObject( objectType, objectId ), false );
	}
} );
