const SITE_WIDE_WARNING =
	'When enabled, the configured meta boxes will not render or submit for anyone on this site. This plugin does not directly change saved meta, but third-party save handlers may react to missing fields; verify each selected meta box before rollout.';

const LEGACY_META_BOX_SELECTOR =
	'.metabox-location-normal, .metabox-location-advanced, .metabox-location-side';
const LEGACY_META_BOX_IFRAME_SELECTOR = LEGACY_META_BOX_SELECTOR.split( ', ' )
	.map( ( selector ) => `${ selector } iframe` )
	.join( ', ' );

export function listenForLegacyMetaBoxChanges( document, onDirty ) {
	const iframeDocuments = new Set();
	const handleChange = ( event ) => {
		if (
			typeof event.target?.closest === 'function' &&
			event.target.closest( LEGACY_META_BOX_SELECTOR )
		) {
			onDirty();
		}
	};
	const attachIframe = ( iframe ) => {
		if (
			typeof iframe?.closest !== 'function' ||
			! iframe.closest( LEGACY_META_BOX_SELECTOR )
		) {
			return;
		}

		let iframeDocument;
		try {
			iframeDocument = iframe.contentDocument;
		} catch {
			return;
		}
		if ( ! iframeDocument || iframeDocuments.has( iframeDocument ) ) {
			return;
		}

		iframeDocuments.add( iframeDocument );
		iframeDocument.addEventListener( 'input', onDirty, true );
		iframeDocument.addEventListener( 'change', onDirty, true );
	};
	const scanIframes = () => {
		document
			.querySelectorAll?.( LEGACY_META_BOX_IFRAME_SELECTOR )
			.forEach( attachIframe );
	};
	const handleIframeLoad = ( event ) => {
		if ( event.target?.tagName === 'IFRAME' ) {
			attachIframe( event.target );
		}
	};
	const MutationObserverClass = document.defaultView?.MutationObserver;
	const observer = MutationObserverClass
		? new MutationObserverClass( scanIframes )
		: null;

	document.addEventListener( 'input', handleChange, true );
	document.addEventListener( 'change', handleChange, true );
	document.addEventListener( 'load', handleIframeLoad, true );
	observer?.observe( document.documentElement, {
		childList: true,
		subtree: true,
	} );
	scanIframes();

	return () => {
		document.removeEventListener( 'input', handleChange, true );
		document.removeEventListener( 'change', handleChange, true );
		document.removeEventListener( 'load', handleIframeLoad, true );
		observer?.disconnect();
		for ( const iframeDocument of iframeDocuments ) {
			iframeDocument.removeEventListener( 'input', onDirty, true );
			iframeDocument.removeEventListener( 'change', onDirty, true );
		}
	};
}

export function getMetaBoxSuppressionUiState( {
	canManage,
	enabled,
	isDirty,
	isSaving,
} ) {
	if ( canManage !== true ) {
		return { visible: false };
	}

	return {
		visible: true,
		enabled: enabled === true,
		disabled: isDirty === true || isSaving === true,
		warning: SITE_WIDE_WARNING,
	};
}

export function createMetaBoxSuppressionController( {
	endpoint,
	getEditorState,
	apiFetch,
	reload,
} ) {
	return {
		async setEnabled( enabled ) {
			const editorState = getEditorState();
			if (
				editorState.isDirty === true ||
				editorState.isSaving === true
			) {
				throw new Error(
					'The post is dirty or saving. Save your work before changing the site-wide meta box policy.'
				);
			}
			if ( typeof enabled !== 'boolean' ) {
				throw new TypeError( 'The enabled setting must be a boolean.' );
			}

			await apiFetch( {
				url: endpoint,
				method: 'POST',
				data: { enabled },
			} );

			const latestEditorState = getEditorState();
			if (
				latestEditorState.isDirty === true ||
				latestEditorState.isSaving === true
			) {
				return { enabled, reloadDeferred: true };
			}

			reload();
			return { enabled, reloadDeferred: false };
		},
	};
}
