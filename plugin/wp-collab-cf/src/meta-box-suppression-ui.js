import apiFetch from '@wordpress/api-fetch';
import { Notice, ToggleControl } from '@wordpress/components';
import { useSelect } from '@wordpress/data';
import { PluginDocumentSettingPanel } from '@wordpress/editor';
import {
	createElement,
	useEffect,
	useMemo,
	useRef,
	useState,
} from '@wordpress/element';
import { registerPlugin } from '@wordpress/plugins';

import {
	createMetaBoxSuppressionController,
	getMetaBoxSuppressionUiState,
	listenForLegacyMetaBoxChanges,
} from './meta-box-suppression.mjs';

function currentEditorState() {
	const editor = window.wp?.data?.select?.( 'core/editor' ) || {};
	const editPost = window.wp?.data?.select?.( 'core/edit-post' ) || {};
	return {
		isDirty: editor.isEditedPostDirty?.() === true,
		isSaving:
			editor.isSavingPost?.() === true ||
			editor.isAutosavingPost?.() === true ||
			editPost.isSavingMetaBoxes?.() === true,
	};
}

function MetaBoxSuppressionPanel() {
	const suppression = window.wpCollabCf?.metaBoxSuppression;
	const editorState = useSelect( currentEditorState, [] );
	const [ requestPending, setRequestPending ] = useState( false );
	const [ error, setError ] = useState( null );
	const [ legacyMetaBoxesDirty, setLegacyMetaBoxesDirty ] = useState( false );
	const [ reloadRequired, setReloadRequired ] = useState( false );
	const legacyMetaBoxesDirtyRef = useRef( false );

	useEffect(
		() =>
			listenForLegacyMetaBoxChanges( window.document, () => {
				legacyMetaBoxesDirtyRef.current = true;
				setLegacyMetaBoxesDirty( true );
			} ),
		[]
	);

	const state = getMetaBoxSuppressionUiState( {
		canManage: suppression?.canManage,
		enabled: suppression?.enabled,
		isDirty: editorState.isDirty || legacyMetaBoxesDirty || reloadRequired,
		isSaving: editorState.isSaving || requestPending,
	} );
	const controller = useMemo(
		() =>
			createMetaBoxSuppressionController( {
				endpoint: suppression?.endpoint,
				getEditorState: () => {
					const latest = currentEditorState();
					return {
						...latest,
						isDirty:
							latest.isDirty || legacyMetaBoxesDirtyRef.current,
					};
				},
				apiFetch,
				reload: () => window.location.reload(),
			} ),
		[ suppression?.endpoint ]
	);

	if ( ! state.visible ) {
		return null;
	}

	const onChange = async ( enabled ) => {
		setError( null );
		setRequestPending( true );
		try {
			const result = await controller.setEnabled( enabled );
			if ( result.reloadDeferred ) {
				setReloadRequired( true );
				setRequestPending( false );
			}
		} catch ( requestError ) {
			setError(
				requestError?.message ||
					'The site-wide meta box policy could not be saved.'
			);
			setRequestPending( false );
		}
	};
	let disabledMessage =
		'Save the post and wait for saving to finish before changing this policy.';
	if ( legacyMetaBoxesDirty ) {
		disabledMessage =
			'A legacy meta box changed. Save your work and reload the editor before changing this policy.';
	}
	if ( reloadRequired ) {
		disabledMessage =
			'The policy was saved, but the editor changed during the request. Save your work, then reload the editor to apply it.';
	}

	return createElement(
		PluginDocumentSettingPanel,
		{
			name: 'wp-collab-cf-meta-box-suppression',
			title: 'Real-time collaboration',
		},
		createElement( 'p', null, state.warning ),
		error
			? createElement(
					Notice,
					{ status: 'error', isDismissible: false },
					error
			  )
			: null,
		state.disabled && ! requestPending
			? createElement(
					Notice,
					{ status: 'warning', isDismissible: false },
					disabledMessage
			  )
			: null,
		createElement( ToggleControl, {
			label: 'Suppress configured meta boxes site-wide',
			checked: state.enabled,
			disabled: state.disabled,
			onChange,
		} )
	);
}

export function registerMetaBoxSuppressionUi() {
	if ( window.wpCollabCf?.metaBoxSuppression?.canManage !== true ) {
		return;
	}

	registerPlugin( 'wp-collab-cf-meta-box-suppression', {
		render: MetaBoxSuppressionPanel,
	} );
}
