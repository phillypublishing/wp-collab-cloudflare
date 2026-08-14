export function getMetaBoxSuppressionUiState( {
	canManage,
	enabled,
	settingsUrl,
} ) {
	const isEnabled = enabled === true;
	return {
		description: isEnabled
			? 'Site-wide legacy meta-box suppression is enabled.'
			: 'Site-wide legacy meta-box suppression is disabled.',
		settingsUrl:
			canManage === true && typeof settingsUrl === 'string' && settingsUrl
				? settingsUrl
				: null,
		status: isEnabled ? 'Suppressed' : 'Shown',
	};
}
