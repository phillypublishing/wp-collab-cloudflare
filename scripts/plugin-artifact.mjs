#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ARTIFACT_FILES = Object.freeze( [
	'wp-collab-cf/build/index.asset.php',
	'wp-collab-cf/build/index.js',
	'wp-collab-cf/includes/compatibility/memberpress.php',
	'wp-collab-cf/includes/compatibility/meta-box-policy.php',
	'wp-collab-cf/includes/compatibility/version-policy.php',
	'wp-collab-cf/includes/compatibility/yoast-seo.php',
	'wp-collab-cf/wp-collab-cf.php',
] );

const TAG_SAFE_VERSION = /^[A-Za-z0-9._+-]+$/;

function requireCommand( command, args, options = {} ) {
	const result = spawnSync( command, args, {
		encoding: 'utf8',
		maxBuffer: 10 * 1024 * 1024,
		...options,
	} );
	if ( result.error ) {
		throw result.error;
	}
	if ( result.status !== 0 ) {
		throw new Error(
			`${ command } ${ args.join( ' ' ) } failed: ${ result.stderr || result.stdout || `exit ${ result.status }` }`
		);
	}
	return result.stdout;
}

export function parsePluginHeaderVersion( source ) {
	const version = source.match(
		/^[\t ]*\*[\t ]*Version:[\t ]*(.*?)[\t ]*$/m
	)?.[ 1 ];
	if ( ! version || ! TAG_SAFE_VERSION.test( version ) ) {
		throw new Error( 'Could not parse a tag-safe plugin Version header.' );
	}
	return version;
}

export function readSourceVersion( pluginDir ) {
	const phpPath = path.join( pluginDir, 'wp-collab-cf.php' );
	const packagePath = path.join( pluginDir, 'package.json' );
	const phpSource = fs.readFileSync( phpPath, 'utf8' );
	const headerVersion = parsePluginHeaderVersion( phpSource );
	const constantVersion = phpSource.match(
		/define\(\s*['"]WP_COLLAB_CF_VERSION['"]\s*,\s*['"]([^'"]+)['"]\s*\)/
	)?.[ 1 ];
	if ( constantVersion !== headerVersion ) {
		throw new Error(
			`WP_COLLAB_CF_VERSION (${ constantVersion ?? 'missing' }) does not match the plugin Version header (${ headerVersion }).`
		);
	}

	let packageVersion;
	try {
		packageVersion = JSON.parse( fs.readFileSync( packagePath, 'utf8' ) ).version;
	} catch ( error ) {
		throw new Error( `Could not read package.json version: ${ error.message }` );
	}
	if ( packageVersion !== headerVersion ) {
		throw new Error(
			`package.json version (${ packageVersion ?? 'missing' }) does not match the plugin Version header (${ headerVersion }).`
		);
	}
	return headerVersion;
}

function sha256File( file ) {
	return crypto.createHash( 'sha256' ).update( fs.readFileSync( file ) ).digest( 'hex' );
}

function assertEqual( field, actual, expected ) {
	if ( actual !== expected ) {
		throw new Error( `${ field } does not match the source commit.` );
	}
}

export function verifyPluginArtifact( artifactDir, options = {} ) {
	const scriptDir = path.dirname( fileURLToPath( import.meta.url ) );
	const repoRoot = options.repoRoot ?? path.resolve( scriptDir, '..' );
	const pluginDir = options.pluginDir ?? path.join( repoRoot, 'plugin/wp-collab-cf' );
	const version = readSourceVersion( pluginDir );
	const commit = options.commit ?? process.env.GITHUB_SHA ?? requireCommand(
		'git', [ '-C', repoRoot, 'rev-parse', 'HEAD' ]
	).trim();
	if ( ! /^[0-9a-f]{40}$/.test( commit ) ) {
		throw new Error( 'The artifact commit must be a full lowercase Git SHA.' );
	}
	const sourceEpoch = requireCommand(
		'git', [ '-C', repoRoot, 'show', '-s', '--format=%ct', commit ]
	).trim();
	if ( ! /^\d+$/.test( sourceEpoch ) ) {
		throw new Error( 'The source commit timestamp must be a non-negative integer.' );
	}
	const repository = options.repository ?? process.env.GITHUB_REPOSITORY ?? 'local';
	const ref = options.ref ?? process.env.GITHUB_REF_NAME ?? requireCommand(
		'git', [ '-C', repoRoot, 'branch', '--show-current' ]
	).trim();
	const expectedBuiltAt = new Date( Number.parseInt( sourceEpoch, 10 ) * 1000 ).toISOString();
	const expectedArtifact = `wp-collab-cf-${ version }-${ commit.slice( 0, 12 ) }.zip`;
	const manifestPath = path.join( artifactDir, 'plugin-artifact-manifest.json' );

	let manifest;
	try {
		manifest = JSON.parse( fs.readFileSync( manifestPath, 'utf8' ) );
	} catch ( error ) {
		throw new Error( `Could not read the artifact manifest: ${ error.message }` );
	}
	const artifactPath = path.join( artifactDir, expectedArtifact );
	const checksumPath = `${ artifactPath }.sha256`;
	for ( const requiredPath of [ artifactPath, checksumPath ] ) {
		if ( ! fs.statSync( requiredPath, { throwIfNoEntry: false } )?.isFile() ) {
			throw new Error( `Required artifact file is missing: ${ path.basename( requiredPath ) }` );
		}
	}

	const artifactSha256 = sha256File( artifactPath );
	const zipEntries = requireCommand( 'unzip', [ '-Z1', artifactPath ] )
		.trimEnd()
		.split( '\n' );
	const checksum = fs.readFileSync( checksumPath, 'utf8' );
	const expectedChecksum = `${ artifactSha256 }  ${ expectedArtifact }\n`;

	assertEqual( 'Manifest schema', manifest.schema, 'wp-collab-cf-plugin-artifact/v1' );
	assertEqual( 'Manifest repository', manifest.repository, repository );
	assertEqual( 'Manifest ref', manifest.ref, ref );
	assertEqual( 'Manifest commit', manifest.commit, commit );
	assertEqual( 'Manifest pluginVersion', manifest.pluginVersion, version );
	assertEqual( 'Manifest artifact', manifest.artifact, expectedArtifact );
	assertEqual( 'Manifest sha256', manifest.sha256, artifactSha256 );
	assertEqual( 'Manifest builtAt', manifest.builtAt, expectedBuiltAt );
	assertEqual(
		'Manifest files',
		JSON.stringify( manifest.files ),
		JSON.stringify( PLUGIN_ARTIFACT_FILES )
	);
	assertEqual(
		'ZIP entries',
		JSON.stringify( zipEntries ),
		JSON.stringify( PLUGIN_ARTIFACT_FILES )
	);
	assertEqual( 'Checksum', checksum, expectedChecksum );

	return {
		version,
		commit,
		artifactPath,
		checksumPath,
		manifestPath,
		files: [ ...PLUGIN_ARTIFACT_FILES ],
	};
}

function usage() {
	throw new Error( 'Usage: plugin-artifact.mjs <version|files|verify> [path]' );
}

function main() {
	const scriptDir = path.dirname( fileURLToPath( import.meta.url ) );
	const repoRoot = path.resolve( scriptDir, '..' );
	const command = process.argv[ 2 ];
	if ( command === 'version' ) {
		console.log( readSourceVersion( process.argv[ 3 ] ?? path.join( repoRoot, 'plugin/wp-collab-cf' ) ) );
		return;
	}
	if ( command === 'files' ) {
		console.log( PLUGIN_ARTIFACT_FILES.join( '\n' ) );
		return;
	}
	if ( command === 'verify' && process.argv[ 3 ] ) {
		const result = verifyPluginArtifact( path.resolve( process.argv[ 3 ] ), { repoRoot } );
		console.log( `Verified ${ result.artifactPath }` );
		return;
	}
	usage();
}

if ( process.argv[ 1 ] && path.resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url ) ) {
	try {
		main();
	} catch ( error ) {
		console.error( error.message );
		process.exitCode = 1;
	}
}
