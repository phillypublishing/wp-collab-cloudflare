/**
 * Return a positive category ID or null for an invalid value.
 *
 * Yoast stores primary term IDs as strings. Keeping that shape at the editor
 * boundary avoids dirty-record churn between REST responses and CRDT updates.
 *
 * @param {*} value Candidate primary category value.
 * @return {number|null} Normalized category ID.
 */
function parseCategoryId( value ) {
	if (
		( typeof value !== 'string' && typeof value !== 'number' ) ||
		! /^\d+$/.test( String( value ) )
	) {
		return null;
	}

	const id = Number.parseInt( String( value ), 10 );
	return Number.isSafeInteger( id ) && id > 0 ? id : null;
}

/**
 * Keep a valid primary category or choose the first selected category.
 *
 * @param {number[]|null} selectedCategoryIds Selected category IDs.
 * @param {*}             primaryCategoryId   Current primary category value.
 * @return {string} REST-safe Yoast primary category value.
 */
export function normalizePrimaryCategory(
	selectedCategoryIds,
	primaryCategoryId
) {
	if ( ! Array.isArray( selectedCategoryIds ) ) {
		return '';
	}

	const selectedIds = selectedCategoryIds
		.map( parseCategoryId )
		.filter( ( id ) => id !== null );
	if ( selectedIds.length === 0 ) {
		return '';
	}

	const primaryId = parseCategoryId( primaryCategoryId );
	return String(
		primaryId !== null && selectedIds.includes( primaryId )
			? primaryId
			: selectedIds[ 0 ]
	);
}

/**
 * Match Yoast's UI rule: one selected category has no meaningful choice.
 *
 * @param {number[]|null} selectedCategoryIds Selected category IDs.
 * @return {boolean} Whether the selector should render.
 */
export function shouldShowPrimaryCategorySelector( selectedCategoryIds ) {
	return Array.isArray( selectedCategoryIds ) && selectedCategoryIds.length > 1;
}

/**
 * Decide whether a category-list change requires an explicit primary value.
 *
 * The bridge must not write on mount or in response to a meta-only peer edit.
 * When the category list changes, match Yoast by persisting the first selected
 * category if the stored value is empty or no longer selected.
 *
 * @param {number[]|null} previousCategoryIds Previously observed categories.
 * @param {number[]|null} selectedCategoryIds Current categories.
 * @param {*}             primaryCategoryId   Stored primary category value.
 * @param {string}        normalizedPrimary   Current normalized value.
 * @return {boolean} Whether the editor should persist the normalized value.
 */
export function shouldReconcilePrimaryCategory(
	previousCategoryIds,
	selectedCategoryIds,
	primaryCategoryId,
	normalizedPrimary
) {
	if (
		! Array.isArray( previousCategoryIds ) ||
		! Array.isArray( selectedCategoryIds )
	) {
		return false;
	}

	const categoriesChanged =
		previousCategoryIds.length !== selectedCategoryIds.length ||
		previousCategoryIds.some(
			( id, index ) => id !== selectedCategoryIds[ index ]
		);
	const currentValue =
		primaryCategoryId === null || primaryCategoryId === undefined
			? ''
			: String( primaryCategoryId );

	return (
		categoriesChanged &&
		currentValue !== normalizedPrimary
	);
}

/**
 * Validate the server-provided bridge configuration.
 *
 * @param {*}       config            Candidate bridge configuration.
 * @param {boolean} filterRegistered  Whether this hook namespace already exists.
 * @return {boolean} Whether the bridge should register.
 */
export function shouldRegisterYoastPrimaryCategoryBridge(
	config,
	filterRegistered
) {
	return (
		filterRegistered !== true &&
		config?.enabled === true &&
		typeof config.metaKey === 'string' &&
		config.metaKey !== '' &&
		config.taxonomy === 'category'
	);
}

/**
 * Register the platform filter after validating its configuration and seam.
 *
 * @param {*}        config            Candidate bridge configuration.
 * @param {boolean}  filterRegistered  Whether this hook namespace already exists.
 * @param {Function} registerFilter    Platform registration callback.
 * @return {boolean} Whether registration ran.
 */
export function registerYoastPrimaryCategoryBridgeFilter(
	config,
	filterRegistered,
	registerFilter
) {
	if (
		! shouldRegisterYoastPrimaryCategoryBridge( config, filterRegistered ) ||
		typeof registerFilter !== 'function'
	) {
		return false;
	}

	registerFilter();
	return true;
}

/**
 * Return whether a taxonomy component is the configured category surface.
 *
 * @param {*}      slug     Taxonomy component slug.
 * @param {string} taxonomy Configured taxonomy slug.
 * @return {boolean} Whether the component should be wrapped.
 */
export function shouldWrapYoastPrimaryCategoryTaxonomy( slug, taxonomy ) {
	return slug === taxonomy;
}
