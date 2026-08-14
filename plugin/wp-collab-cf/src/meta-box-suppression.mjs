export function getMetaBoxSuppressionUiState( {
	canManage,
	enabled,
	settingsUrl,
} ) {
	const isEnabled = enabled === true;
	return {
		settingsUrl:
			canManage === true && typeof settingsUrl === 'string' && settingsUrl
				? settingsUrl
				: null,
		status: isEnabled
			? 'Site-wide legacy meta-box suppression is enabled.'
			: 'Site-wide legacy meta-box suppression is disabled.',
	};
}
