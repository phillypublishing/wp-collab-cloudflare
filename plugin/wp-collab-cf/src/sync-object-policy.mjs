const OBJECT_TYPE_PATTERN = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;
const POST_TYPE_PATTERN = /^postType\/[A-Za-z0-9_-]+$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

/**
 * Return whether a Gutenberg provider request has a supported public shape.
 * WordPress remains authoritative for entity existence and user permission.
 *
 * @param {string} objectType Gutenberg entity kind/name.
 * @param {number|string|null} objectId Entity ID, or null for a collection.
 * @return {boolean} Whether the provider may request WordPress credentials.
 */
export function isSupportedSyncObject( objectType, objectId ) {
	if (
		typeof objectType !== 'string' ||
		objectType.length > 128 ||
		! OBJECT_TYPE_PATTERN.test( objectType )
	) {
		return false;
	}

	if ( objectId === null ) {
		return true;
	}

	return (
		POST_TYPE_PATTERN.test( objectType ) &&
		POSITIVE_INTEGER_PATTERN.test( String( objectId ) )
	);
}
