import assert from 'node:assert/strict';
import test from 'node:test';

import {
	normalizePrimaryCategory,
	registerYoastPrimaryCategoryBridgeFilter,
	shouldReconcilePrimaryCategory,
	shouldRegisterYoastPrimaryCategoryBridge,
	shouldShowPrimaryCategorySelector,
	shouldWrapYoastPrimaryCategoryTaxonomy,
} from '../src/yoast-primary-category-policy.mjs';

test( 'preserves a selected primary category as a REST-safe string', () => {
	assert.equal( normalizePrimaryCategory( [ 12, 34 ], '34' ), '34' );
	assert.equal( normalizePrimaryCategory( [ 12, 34 ], 34 ), '34' );
} );

test( 'falls back deterministically when the primary category is removed', () => {
	assert.equal( normalizePrimaryCategory( [ 12, 34 ], '99' ), '12' );
	assert.equal( normalizePrimaryCategory( [ 34, 12 ], '' ), '34' );
	assert.equal( normalizePrimaryCategory( [ 12, 34 ], '34x' ), '12' );
} );

test( 'clears the primary category when the post has no categories', () => {
	assert.equal( normalizePrimaryCategory( [], '34' ), '' );
	assert.equal( normalizePrimaryCategory( null, '34' ), '' );
} );

test( 'shows the picker only when there is a meaningful choice', () => {
	assert.equal( shouldShowPrimaryCategorySelector( [] ), false );
	assert.equal( shouldShowPrimaryCategorySelector( [ 12 ] ), false );
	assert.equal( shouldShowPrimaryCategorySelector( [ 12, 34 ] ), true );
} );

test( 'reconciles only after a category-list change invalidates stored meta', () => {
	assert.equal(
		shouldReconcilePrimaryCategory( null, [ 12 ], '34', '12' ),
		false,
		'mount must not dirty the post'
	);
	assert.equal(
		shouldReconcilePrimaryCategory( [ 12 ], [ 12 ], '34', '12' ),
		false,
		'a meta-only peer edit must not trigger a competing write'
	);
	assert.equal(
		shouldReconcilePrimaryCategory( [ 12, 34 ], [ 12 ], '34', '12' ),
		true,
		'removing the stored primary must choose a deterministic fallback'
	);
	assert.equal(
		shouldReconcilePrimaryCategory( [ 12, 34 ], [ 12 ], '', '12' ),
		false,
		'Yoast\'s implicit primary state must remain empty'
	);
} );

test( 'registers the browser bridge only for exact eligible config', () => {
	const eligible = {
		enabled: true,
		metaKey: '_yoast_wpseo_primary_category',
		taxonomy: 'category',
	};

	assert.equal(
		shouldRegisterYoastPrimaryCategoryBridge( eligible, false ),
		true
	);
	assert.equal(
		shouldRegisterYoastPrimaryCategoryBridge( eligible, true ),
		false
	);
	assert.equal(
		shouldRegisterYoastPrimaryCategoryBridge(
			{ ...eligible, enabled: false },
			false
		),
		false
	);
	assert.equal(
		shouldRegisterYoastPrimaryCategoryBridge(
			{ ...eligible, metaKey: '' },
			false
		),
		false
	);
	assert.equal(
		shouldRegisterYoastPrimaryCategoryBridge(
			{ ...eligible, taxonomy: 'post_tag' },
			false
		),
		false
	);
} );

test( 'runs the platform registration seam once for an eligible bridge', () => {
	const eligible = {
		enabled: true,
		metaKey: '_yoast_wpseo_primary_category',
		taxonomy: 'category',
	};
	let registrations = 0;
	const register = () => {
		registrations += 1;
	};

	assert.equal(
		registerYoastPrimaryCategoryBridgeFilter( eligible, false, register ),
		true
	);
	assert.equal( registrations, 1 );
	assert.equal(
		registerYoastPrimaryCategoryBridgeFilter( eligible, true, register ),
		false
	);
	assert.equal(
		registerYoastPrimaryCategoryBridgeFilter(
			{ ...eligible, enabled: false },
			false,
			register
		),
		false
	);
	assert.equal( registrations, 1 );
	assert.equal(
		shouldWrapYoastPrimaryCategoryTaxonomy( 'category', 'category' ),
		true
	);
	assert.equal(
		shouldWrapYoastPrimaryCategoryTaxonomy( 'post_tag', 'category' ),
		false
	);
} );
