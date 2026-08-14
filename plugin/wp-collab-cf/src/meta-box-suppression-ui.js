import { Button } from '@wordpress/components';
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
		createElement( 'span', null, 'Legacy meta boxes' ),
		state.settingsUrl
			? createElement(
					Button,
					{
						'aria-label': `Manage legacy meta-box suppression settings. ${ state.description }`,
						href: state.settingsUrl,
						size: 'compact',
						variant: 'link',
					},
					state.status
			  )
			: createElement(
					'span',
					{ 'aria-label': state.description },
					state.status
			  )
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
