import { SelectControl } from '@wordpress/components';
import { useDispatch, useSelect } from '@wordpress/data';
import { createElement, Fragment, useEffect, useRef } from '@wordpress/element';
import { addFilter, hasFilter } from '@wordpress/hooks';
import { __, sprintf } from '@wordpress/i18n';

import {
	normalizePrimaryCategory,
	registerYoastPrimaryCategoryBridgeFilter,
	shouldReconcilePrimaryCategory,
	shouldShowPrimaryCategorySelector,
	shouldWrapYoastPrimaryCategoryTaxonomy,
} from './yoast-primary-category-policy.mjs';

const FILTER_NAMESPACE = 'wp-collab-cf/yoast-primary-category';

/**
 * Add an RTC-backed Primary Category selector beneath WordPress's category UI.
 *
 * @param {Object}   props                   Component props.
 * @param {Function} props.OriginalComponent Core taxonomy component.
 * @param {string}   props.metaKey           Registered Yoast meta key.
 * @param {string}   props.taxonomy          Target taxonomy slug.
 * @return {Element} Wrapped taxonomy editor.
 */
function PrimaryCategoryTaxonomy( {
	OriginalComponent,
	metaKey,
	taxonomy,
	...taxonomyProps
} ) {
	const { selectedCategoryIds, primaryCategoryId, categories, metaLoaded } =
		useSelect(
			( select ) => {
				const editor = select( 'core/editor' );
				const core = select( 'core' );
				const selectedIds = editor?.getEditedPostAttribute?.(
					'categories'
				);
				const meta = editor?.getEditedPostAttribute?.( 'meta' );
				const selectedCategories = Array.isArray( selectedIds )
					? selectedIds.map( ( id ) =>
							core?.getEntityRecord?.( 'taxonomy', taxonomy, id )
					  )
					: [];

				return {
					selectedCategoryIds: selectedIds,
					primaryCategoryId: meta?.[ metaKey ],
					categories: selectedCategories,
					metaLoaded:
						meta !== null &&
						typeof meta === 'object' &&
						Object.prototype.hasOwnProperty.call( meta, metaKey ),
				};
			},
			[ metaKey, taxonomy ]
		);
	const editorDispatch = useDispatch( 'core/editor' );
	const previousCategoryIds = useRef( selectedCategoryIds );
	const normalizedPrimary = normalizePrimaryCategory(
		selectedCategoryIds,
		primaryCategoryId
	);

	useEffect( () => {
		const previousIds = previousCategoryIds.current;
		previousCategoryIds.current = selectedCategoryIds;
		if (
			! metaLoaded ||
			! Array.isArray( selectedCategoryIds ) ||
			typeof editorDispatch?.editPost !== 'function'
		) {
			return;
		}

		if (
			shouldReconcilePrimaryCategory(
				previousIds,
				selectedCategoryIds,
				primaryCategoryId,
				normalizedPrimary
			)
		) {
			editorDispatch.editPost( {
				meta: { [ metaKey ]: normalizedPrimary },
			} );
		}
	}, [
		editorDispatch,
		metaKey,
		metaLoaded,
		normalizedPrimary,
		primaryCategoryId,
		selectedCategoryIds,
	] );

	const original = createElement( OriginalComponent, taxonomyProps );
	if ( ! shouldShowPrimaryCategorySelector( selectedCategoryIds ) ) {
		return original;
	}

	const options = selectedCategoryIds.map( ( id, index ) => ( {
		label:
			categories[ index ]?.name ||
			sprintf( __( 'Category #%d', 'wp-collab-cf' ), id ),
		value: String( id ),
	} ) );

	return createElement(
		Fragment,
		null,
		original,
		createElement(
			'div',
			{ className: 'wp-collab-cf-yoast-primary-category' },
			createElement( SelectControl, {
				label: __( 'Primary category', 'wp-collab-cf' ),
				help: __(
					'Used by Yoast SEO for breadcrumbs and primary-category metadata.',
					'wp-collab-cf'
				),
				onChange: ( value ) => {
					const nextValue = normalizePrimaryCategory(
						selectedCategoryIds,
						value
					);
					editorDispatch?.editPost?.( {
						meta: { [ metaKey ]: nextValue },
					} );
				},
				options,
				value: normalizedPrimary,
			} )
		)
	);
}

/**
 * Register the bridge at the same taxonomy extension seam used by Yoast.
 */
export function registerYoastPrimaryCategoryBridge() {
	const config = window.wpCollabCf?.yoastPrimaryCategory;
	registerYoastPrimaryCategoryBridgeFilter(
		config,
		hasFilter( 'editor.PostTaxonomyType', FILTER_NAMESPACE ),
		() =>
			addFilter(
				'editor.PostTaxonomyType',
				FILTER_NAMESPACE,
				( OriginalComponent ) => ( props ) => {
					if (
						! shouldWrapYoastPrimaryCategoryTaxonomy(
							props.slug,
							config.taxonomy
						)
					) {
						return createElement( OriginalComponent, props );
					}

					return createElement( PrimaryCategoryTaxonomy, {
						...props,
						OriginalComponent,
						metaKey: config.metaKey,
						taxonomy: config.taxonomy,
					} );
				}
			)
	);
}
