import { PluginPostStatusInfo } from '@wordpress/editor';
import { createElement } from '@wordpress/element';
import { registerPlugin } from '@wordpress/plugins';

import { getMetaBoxSuppressionUiState } from './meta-box-suppression.mjs';

function MetaBoxSuppressionPanel() {
	const suppression = window.wpCollabCf?.metaBoxSuppression || {};
	const state = getMetaBoxSuppressionUiState( suppression );

	return createElement(
		PluginPostStatusInfo,
		{
			className: 'wp-collab-cf-meta-box-suppression',
		},
		createElement( 'strong', null, 'Real-time collaboration' ),
		createElement( 'p', null, state.status ),
		state.settingsUrl
			? createElement(
					'p',
					null,
					createElement(
						'a',
						{ href: state.settingsUrl },
						'Manage site-wide settings'
					)
			  )
			: null
	);
}

export function registerMetaBoxSuppressionUi() {
	if ( ! window.wpCollabCf?.metaBoxSuppression ) {
		return;
	}

	registerPlugin( 'wp-collab-cf-meta-box-suppression', {
		render: MetaBoxSuppressionPanel,
	} );
}
