import assert from 'node:assert/strict';
import test from 'node:test';

import { handleConnectionClose } from '../src/connection-policy.mjs';

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

test( 'authentication expiry remains reconnectable', () => {
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
