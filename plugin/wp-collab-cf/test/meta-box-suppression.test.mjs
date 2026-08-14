import assert from 'node:assert/strict';
import test from 'node:test';

import { getMetaBoxSuppressionUiState } from '../src/meta-box-suppression.mjs';

test( 'shows every editor the site-wide policy status without a mutation control', () => {
	assert.deepEqual(
		getMetaBoxSuppressionUiState( {
			canManage: false,
			enabled: true,
			settingsUrl: '',
		} ),
		{
			description: 'Site-wide legacy meta-box suppression is enabled.',
			settingsUrl: null,
			status: 'Suppressed',
		}
	);
} );

test( 'links administrators to the dedicated Settings page', () => {
	assert.deepEqual(
		getMetaBoxSuppressionUiState( {
			canManage: true,
			enabled: false,
			settingsUrl:
				'https://example.test/wp-admin/options-general.php?page=wp-collab-cf',
		} ),
		{
			description: 'Site-wide legacy meta-box suppression is disabled.',
			settingsUrl:
				'https://example.test/wp-admin/options-general.php?page=wp-collab-cf',
			status: 'Shown',
		}
	);
} );

test( 'does not expose an invalid Settings link', () => {
	assert.equal(
		getMetaBoxSuppressionUiState( {
			canManage: true,
			enabled: false,
			settingsUrl: null,
		} ).settingsUrl,
		null
	);
} );
