#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
	parsePluginHeaderVersion,
	readSourceVersion,
	verifyPluginArtifact,
} from './plugin-artifact.mjs';

const PLUGIN_PATH = 'plugin/wp-collab-cf/wp-collab-cf.php';
const ZERO_SHA = '0'.repeat( 40 );
const DEFAULT_MAX_API_PAGES = 100;
export const RELEASE_BODY = 'Automated plugin release from main. Verify the ZIP with the attached SHA-256 checksum; the manifest records the exact source commit and allowlisted runtime files.';

export class HttpError extends Error {
	constructor( status, message, body = null ) {
		super( `GitHub API HTTP ${ status }: ${ message }` );
		this.name = 'HttpError';
		this.status = status;
		this.body = body;
	}
}

function runGit( repoRoot, args, { allowFailure = false } = {} ) {
	const result = spawnSync( 'git', [ '-C', repoRoot, ...args ], {
		encoding: 'utf8',
		maxBuffer: 10 * 1024 * 1024,
	} );
	if ( result.error ) {
		throw result.error;
	}
	if ( result.status !== 0 && ! allowFailure ) {
		throw new Error(
			`git ${ args.join( ' ' ) } failed: ${ result.stderr || result.stdout || `exit ${ result.status }` }`
		);
	}
	return result;
}

export function detectRelease( { repoRoot, beforeSha, expectedSha } ) {
	if ( ! /^[0-9a-f]{40}$/.test( beforeSha ?? '' ) ) {
		throw new Error( 'BEFORE_SHA must be a full lowercase Git SHA.' );
	}
	const currentSha = runGit( repoRoot, [ 'rev-parse', 'HEAD' ] ).stdout.trim();
	if ( expectedSha && currentSha !== expectedSha ) {
		throw new Error( `Checked-out commit ${ currentSha } does not match GITHUB_SHA ${ expectedSha }.` );
	}
	const pluginDir = path.join( repoRoot, 'plugin/wp-collab-cf' );
	const version = readSourceVersion( pluginDir );

	let previousVersion = null;
	if ( beforeSha !== ZERO_SHA ) {
		const beforeCommit = runGit(
			repoRoot,
			[ 'cat-file', '-e', `${ beforeSha }^{commit}` ],
			{ allowFailure: true }
		);
		if ( beforeCommit.status !== 0 ) {
			throw new Error( `Before commit ${ beforeSha } is unavailable; refusing to infer a release.` );
		}
		const ancestry = runGit(
			repoRoot,
			[ 'merge-base', '--is-ancestor', beforeSha, currentSha ],
			{ allowFailure: true }
		);
		if ( ancestry.status !== 0 ) {
			throw new Error( `Before commit ${ beforeSha } is not an ancestor of ${ currentSha }; refusing to infer a release.` );
		}
		const priorPath = runGit(
			repoRoot,
			[ 'ls-tree', '-z', '--name-only', beforeSha, '--', PLUGIN_PATH ]
		).stdout;
		if ( priorPath !== '' ) {
			const priorSource = runGit(
				repoRoot,
				[ 'show', `${ beforeSha }:${ PLUGIN_PATH }` ]
			).stdout;
			previousVersion = parsePluginHeaderVersion( priorSource );
		}
	}

	if ( previousVersion === version ) {
		return { release: false, version, previousVersion, tag: null };
	}
	const tag = `wp-collab-cf-v${ version }`;
	const refCheck = runGit(
		repoRoot,
		[ 'check-ref-format', `refs/tags/${ tag }` ],
		{ allowFailure: true }
	);
	if ( refCheck.status !== 0 ) {
		throw new Error( `Version ${ version } does not produce a valid Git tag.` );
	}
	return { release: true, version, previousVersion, tag };
}

function parseIncludedResponse( result, method, endpoint ) {
	if ( result.error ) {
		throw result.error;
	}
	const stdout = result.stdout ?? '';
	const statuses = [ ...stdout.matchAll( /^HTTP\/\S+\s+(\d{3})[^\r\n]*$/gm ) ];
	if ( statuses.length === 0 ) {
		const detail = ( result.stderr || stdout || `exit ${ result.status }` ).trim();
		throw new Error( `GitHub API ${ method } ${ endpoint } failed without an HTTP response: ${ detail }` );
	}
	const status = Number.parseInt( statuses.at( -1 )[ 1 ], 10 );
	const sections = stdout.split( /\r?\n\r?\n/ );
	const bodyText = sections.at( -1 ).trim();
	let body = null;
	if ( bodyText !== '' ) {
		try {
			body = JSON.parse( bodyText );
		} catch ( error ) {
			throw new Error( `GitHub API ${ method } ${ endpoint } returned invalid JSON: ${ error.message }` );
		}
	}
	if ( status < 200 || status >= 300 ) {
		throw new HttpError( status, body?.message ?? result.stderr?.trim() ?? 'request failed', body );
	}
	if ( result.status !== 0 ) {
		throw new Error( `GitHub API ${ method } ${ endpoint } exited ${ result.status } after HTTP ${ status }.` );
	}
	return body;
}

export function uploadReleaseAsset( {
	repository,
	releaseId,
	file,
	token,
	requestImpl = https.request,
} ) {
	if ( ! token ) {
		throw new Error( 'GH_TOKEN is required for release asset upload.' );
	}
	const name = path.basename( file );
	const endpoint = `/repos/${ repository }/releases/${ releaseId }/assets?name=${ encodeURIComponent( name ) }`;
	const size = fs.statSync( file ).size;
	return new Promise( ( resolve, reject ) => {
		const request = requestImpl( {
			hostname: 'uploads.github.com',
			path: endpoint,
			method: 'POST',
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${ token }`,
				'Content-Length': size,
				'Content-Type': 'application/octet-stream',
				'User-Agent': 'wp-collab-cloudflare-release',
				'X-GitHub-Api-Version': '2022-11-28',
			},
		}, ( response ) => {
			const chunks = [];
			response.on( 'data', ( chunk ) => chunks.push( chunk ) );
			response.on( 'error', reject );
			response.on( 'end', () => {
				const bodyText = Buffer.concat( chunks ).toString( 'utf8' );
				let body = null;
				if ( bodyText !== '' ) {
					try {
						body = JSON.parse( bodyText );
					} catch ( error ) {
						reject( new Error( `GitHub asset upload returned invalid JSON: ${ error.message }` ) );
						return;
					}
				}
				const status = response.statusCode ?? 0;
				if ( status < 200 || status >= 300 ) {
					reject( new HttpError( status, body?.message ?? 'asset upload failed', body ) );
					return;
				}
				resolve( body );
			} );
		} );
		request.on( 'error', reject );
		const stream = fs.createReadStream( file );
		stream.on( 'error', ( error ) => request.destroy( error ) );
		stream.pipe( request );
	} );
}

export class GitHubGateway {
	constructor( {
		repository,
		spawnSyncImpl = spawnSync,
		maxPages = DEFAULT_MAX_API_PAGES,
		uploadRequestImpl = uploadReleaseAsset,
	} ) {
		if ( ! /^[^/\s]+\/[^/\s]+$/.test( repository ?? '' ) ) {
			throw new Error( 'GITHUB_REPOSITORY must be in owner/repository form.' );
		}
		if ( ! Number.isInteger( maxPages ) || maxPages < 1 ) {
			throw new Error( 'GitHub API page limit must be a positive integer.' );
		}
		this.repository = repository;
		this.spawnSync = spawnSyncImpl;
		this.maxPages = maxPages;
		this.uploadRequest = uploadRequestImpl;
	}

	async request( method, endpoint, body = null ) {
		const args = [
			'api',
			'--include',
			'--method',
			method,
			endpoint,
			'-H',
			'Accept: application/vnd.github+json',
			'-H',
			'X-GitHub-Api-Version: 2022-11-28',
		];
		if ( body !== null ) {
			args.push( '--input', '-' );
		}
		const result = this.spawnSync( 'gh', args, {
			encoding: 'utf8',
			input: body === null ? undefined : JSON.stringify( body ),
			env: process.env,
			maxBuffer: 10 * 1024 * 1024,
		} );
		return parseIncludedResponse( result, method, endpoint );
	}

	async getTagRef( tag ) {
		try {
			return await this.request(
				'GET',
				`repos/${ this.repository }/git/ref/tags/${ encodeURIComponent( tag ) }`
			);
		} catch ( error ) {
			if ( error instanceof HttpError && error.status === 404 ) {
				return null;
			}
			throw error;
		}
	}

	async createTagRef( tag, sha ) {
		return this.request( 'POST', `repos/${ this.repository }/git/refs`, {
			ref: `refs/tags/${ tag }`,
			sha,
		} );
	}

	async getRelease( tag ) {
		try {
			return await this.request(
				'GET',
				`repos/${ this.repository }/releases/tags/${ encodeURIComponent( tag ) }`
			);
		} catch ( error ) {
			if ( error instanceof HttpError && error.status === 404 ) {
				const releases = await this.listReleasesByTag( tag );
				if ( releases.length > 1 ) {
					throw new Error( `Found multiple GitHub releases for tag ${ tag }; refusing ambiguous recovery.` );
				}
				return releases[ 0 ] ?? null;
			}
			throw error;
		}
	}

	async paginate( endpointForPage, label ) {
		const items = [];
		for ( let page = 1; page <= this.maxPages; page++ ) {
			const batch = await this.request( 'GET', endpointForPage( page ) );
			if ( ! Array.isArray( batch ) ) {
				throw new Error( `${ label } response is not an array.` );
			}
			items.push( ...batch );
			if ( batch.length < 100 ) {
				return items;
			}
		}
		throw new Error( `${ label } exceeded the GitHub API page limit of ${ this.maxPages }.` );
	}

	async listReleasesByTag( tag ) {
		const releases = await this.paginate(
			( page ) => `repos/${ this.repository }/releases?per_page=100&page=${ page }`,
			'GitHub releases'
		);
		return releases.filter( ( release ) => release?.tag_name === tag );
	}

	async createDraft( spec ) {
		return this.request( 'POST', `repos/${ this.repository }/releases`, spec );
	}

	async listAssets( releaseId ) {
		return this.paginate(
			( page ) => `repos/${ this.repository }/releases/${ releaseId }/assets?per_page=100&page=${ page }`,
			'GitHub release assets'
		);
	}

	async uploadAsset( releaseId, file ) {
		if ( ! Number.isInteger( releaseId ) ) {
			throw new Error( 'GitHub release id must be numeric for asset upload.' );
		}
		return this.uploadRequest( {
			repository: this.repository,
			releaseId,
			file,
			token: process.env.GH_TOKEN,
		} );
	}

	async publishDraft( releaseId ) {
		return this.request(
			'PATCH',
			`repos/${ this.repository }/releases/${ releaseId }`,
			{ draft: false }
		);
	}
}

function releaseSpec( { tag, sha, version } ) {
	return {
		tag_name: tag,
		target_commitish: sha,
		name: `WP Collab Cloudflare ${ version }`,
		body: RELEASE_BODY,
		draft: true,
		prerelease: false,
	};
}

function verifyTagRef( ref, tag, sha ) {
	if ( ref?.ref !== `refs/tags/${ tag }` || ref?.object?.sha !== sha ) {
		throw new Error( `Release tag ${ tag } does not target GITHUB_SHA ${ sha }.` );
	}
}

function verifyReleaseMetadata( release, spec, expectedDraft ) {
	if ( ! Number.isInteger( release?.id ) ) {
		throw new Error( 'GitHub release does not have a numeric id.' );
	}
	// target_commitish is intentionally not compared: GitHub documents it as
	// unused when the tag already exists. The separately verified tag ref is the
	// authoritative release-to-commit binding.
	for ( const field of [ 'tag_name', 'name', 'body', 'prerelease' ] ) {
		if ( release[ field ] !== spec[ field ] ) {
			throw new Error( `GitHub release ${ field } does not match the requested release.` );
		}
	}
	if ( release.draft !== expectedDraft ) {
		throw new Error( `GitHub release draft state does not match ${ expectedDraft }.` );
	}
}

function expectedAssets( files ) {
	const seen = new Set();
	return files.map( ( file ) => {
		const name = path.basename( file );
		if ( seen.has( name ) ) {
			throw new Error( `Duplicate local release asset name: ${ name }` );
		}
		seen.add( name );
		const bytes = fs.readFileSync( file );
		return {
			file,
			name,
			size: bytes.length,
			digest: `sha256:${ crypto.createHash( 'sha256' ).update( bytes ).digest( 'hex' ) }`,
		};
	} );
}

function verifyRemoteAsset( observed, wanted ) {
	if ( observed?.state !== 'uploaded' ) {
		throw new Error( `GitHub release asset ${ wanted.name } state is not uploaded.` );
	}
	if ( observed.size !== wanted.size ) {
		throw new Error( `GitHub release asset ${ wanted.name } size does not match.` );
	}
	if ( observed.digest !== wanted.digest ) {
		throw new Error( `GitHub release asset ${ wanted.name } digest does not match.` );
	}
}

function verifyAssetSubset( actual, expected ) {
	const expectedByName = new Map( expected.map( ( asset ) => [asset.name, asset] ) );
	const names = new Set();
	for ( const asset of actual ) {
		if ( names.has( asset.name ) || ! expectedByName.has( asset.name ) ) {
			throw new Error( `Draft contains a conflicting release asset: ${ asset.name }` );
		}
		names.add( asset.name );
		verifyRemoteAsset( asset, expectedByName.get( asset.name ) );
	}
	return expected.filter( ( asset ) => ! names.has( asset.name ) );
}

function verifyExactAssets( actual, expected ) {
	verifyAssetSubset( actual, expected );
	if ( actual.length !== expected.length ) {
		throw new Error( 'GitHub release does not contain the exact release asset set.' );
	}
}

async function verifyCurrentTag( gateway, tag, sha ) {
	const ref = await gateway.getTagRef( tag );
	if ( ref === null ) {
		throw new Error( `Release tag ${ tag } is absent.` );
	}
	verifyTagRef( ref, tag, sha );
}

async function uploadMissingAssets( gateway, releaseId, wantedAssets ) {
	let missing = verifyAssetSubset( await gateway.listAssets( releaseId ), wantedAssets );
	for ( const wanted of missing ) {
		missing = verifyAssetSubset( await gateway.listAssets( releaseId ), wantedAssets );
		if ( ! missing.some( ( asset ) => asset.name === wanted.name ) ) {
			continue;
		}
		try {
			await gateway.uploadAsset( releaseId, wanted.file );
		} catch ( error ) {
			if ( !( error instanceof HttpError ) || error.status !== 422 ) {
				throw error;
			}
		}
		const afterUpload = verifyAssetSubset( await gateway.listAssets( releaseId ), wantedAssets );
		if ( afterUpload.some( ( asset ) => asset.name === wanted.name ) ) {
			throw new Error( `GitHub release asset ${ wanted.name } is still absent after upload.` );
		}
	}
	verifyExactAssets( await gateway.listAssets( releaseId ), wantedAssets );
}

export async function reconcilePluginRelease( input, gateway ) {
	if ( input.tag !== `wp-collab-cf-v${ input.version }` ) {
		throw new Error( 'Release tag does not match the plugin version.' );
	}
	if ( ! /^[0-9a-f]{40}$/.test( input.sha ) ) {
		throw new Error( 'Release SHA must be a full lowercase Git commit id.' );
	}
	const wantedAssets = expectedAssets( input.assets );
	const spec = releaseSpec( input );

	let ref = await gateway.getTagRef( input.tag );
	if ( ref === null ) {
		try {
			ref = await gateway.createTagRef( input.tag, input.sha );
		} catch ( error ) {
			if ( !( error instanceof HttpError ) || error.status !== 422 ) {
				throw error;
			}
			ref = await gateway.getTagRef( input.tag );
			if ( ref === null ) {
				throw new Error( `Release tag ${ input.tag } raced but is still absent.` );
			}
		}
	}
	verifyTagRef( ref, input.tag, input.sha );

	let release = await gateway.getRelease( input.tag );
	if ( release === null ) {
		try {
			release = await gateway.createDraft( spec );
		} catch ( error ) {
			if ( !( error instanceof HttpError ) || error.status !== 422 ) {
				throw error;
			}
			release = await gateway.getRelease( input.tag );
			if ( release === null ) {
				throw new Error( `Release ${ input.tag } raced but is still absent.` );
			}
		}
	}

	if ( release.draft === false ) {
		verifyReleaseMetadata( release, spec, false );
		verifyExactAssets( await gateway.listAssets( release.id ), wantedAssets );
		await verifyCurrentTag( gateway, input.tag, input.sha );
		return { status: 'already-published', releaseId: release.id };
	}
	verifyReleaseMetadata( release, spec, true );
	await uploadMissingAssets( gateway, release.id, wantedAssets );
	await verifyCurrentTag( gateway, input.tag, input.sha );
	const published = await gateway.publishDraft( release.id );
	await verifyCurrentTag( gateway, input.tag, input.sha );
	verifyReleaseMetadata( published, spec, false );

	const observed = await gateway.getRelease( input.tag );
	verifyReleaseMetadata( observed, spec, false );
	if ( observed.id !== release.id ) {
		throw new Error( 'Published release id changed during verification.' );
	}
	verifyExactAssets( await gateway.listAssets( release.id ), wantedAssets );
	return { status: 'published', releaseId: release.id };
}

function writeDetectionOutputs( result, outputPath ) {
	const lines = [
		`release=${ result.release }`,
		`version=${ result.version }`,
	];
	if ( result.tag ) {
		lines.push( `tag=${ result.tag }` );
	}
	fs.appendFileSync( outputPath, `${ lines.join( '\n' ) }\n` );
}

async function main() {
	const scriptDir = path.dirname( fileURLToPath( import.meta.url ) );
	const repoRoot = path.resolve( scriptDir, '..' );
	const command = process.argv[ 2 ];
	if ( command === 'detect' ) {
		if ( ! process.env.GITHUB_OUTPUT ) {
			throw new Error( 'GITHUB_OUTPUT is required for release detection.' );
		}
		const result = detectRelease( {
			repoRoot,
			beforeSha: process.env.BEFORE_SHA,
			expectedSha: process.env.GITHUB_SHA,
		} );
		writeDetectionOutputs( result, process.env.GITHUB_OUTPUT );
		console.log(
			result.release
				? `Version changed: ${ result.previousVersion ?? '<new plugin>' } -> ${ result.version }`
				: `Version unchanged (${ result.version }); no release will be created.`
		);
		return;
	}
	if ( command === 'publish' && process.argv[ 3 ] ) {
		for ( const variable of [ 'GH_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_SHA', 'RELEASE_TAG', 'RELEASE_VERSION' ] ) {
			if ( ! process.env[ variable ] ) {
				throw new Error( `${ variable } is required for publication.` );
			}
		}
		const artifact = verifyPluginArtifact( path.resolve( process.argv[ 3 ] ), { repoRoot } );
		if ( artifact.version !== process.env.RELEASE_VERSION ) {
			throw new Error( 'Verified artifact version does not match the release decision.' );
		}
		const result = await reconcilePluginRelease(
			{
				repository: process.env.GITHUB_REPOSITORY,
				sha: process.env.GITHUB_SHA,
				tag: process.env.RELEASE_TAG,
				version: process.env.RELEASE_VERSION,
				assets: [artifact.artifactPath, artifact.checksumPath, artifact.manifestPath],
			},
			new GitHubGateway( { repository: process.env.GITHUB_REPOSITORY } )
		);
		console.log( `Release ${ process.env.RELEASE_TAG }: ${ result.status }.` );
		return;
	}
	throw new Error( 'Usage: plugin-release.mjs <detect|publish> [artifact-directory]' );
}

if ( process.argv[ 1 ] && path.resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url ) ) {
	main().catch( ( error ) => {
		console.error( error.message );
		process.exitCode = 1;
	} );
}
