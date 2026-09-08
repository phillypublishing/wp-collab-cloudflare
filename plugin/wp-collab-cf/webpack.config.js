const path = require( 'path' );
const defaultConfig = require( '@wordpress/scripts/config/webpack.config' );

module.exports = {
	...defaultConfig,
	resolve: {
		...( defaultConfig.resolve || {} ),
		alias: {
			...( defaultConfig.resolve?.alias || {} ),
			// Share the editor's Yjs module, supplied when the provider is created,
			// instead of bundling a second copy of the library.
			yjs: path.resolve( __dirname, 'src/yjs-shim.js' ),
		},
	},
};
