import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import test, { after } from 'node:test';

import { readSourceVersion } from '../scripts/plugin-artifact.mjs';
import {
	GitHubGateway,
	HttpError,
	RELEASE_BODY,
	detectRelease,
	reconcilePluginRelease,
	uploadReleaseAsset,
} from '../scripts/plugin-release.mjs';

const ZERO_SHA = '0'.repeat( 40 );
const TEST_ROOT = fs.mkdtempSync( path.join( os.tmpdir(), 'plugin-release-test-' ) );

after( () => fs.rmSync( TEST_ROOT, { recursive: true, force: true } ) );

function git( repo, ...args ) {
	const result = spawnSync( 'git', args, { cwd: repo, encoding: 'utf8' } );
	if ( result.status !== 0 ) {
		throw new Error( result.stderr || result.stdout );
	}
	return result.stdout.trim();
}

function writePlugin( repo, header, constant = header, packageVersion = header ) {
	const pluginDir = path.join( repo, 'plugin/wp-collab-cf' );
	fs.mkdirSync( pluginDir, { recursive: true } );
	fs.writeFileSync(
		path.join( pluginDir, 'wp-collab-cf.php' ),
		`<?php\n/**\n * Plugin Name: Fixture\n * Version: ${ header }\n */\ndefine( 'WP_COLLAB_CF_VERSION', '${ constant }' );\n`
	);
	fs.writeFileSync(
		path.join( pluginDir, 'package.json' ),
		`${ JSON.stringify( { version: packageVersion }, null, 2 ) }\n`
	);
	return pluginDir;
}

function createRepository( initialVersion = '0.1.0' ) {
	const repo = fs.mkdtempSync( path.join( TEST_ROOT, 'git-' ) );
	git( repo, 'init', '-q' );
	git( repo, 'config', 'user.name', 'Release Test' );
	git( repo, 'config', 'user.email', 'release@example.test' );
	writePlugin( repo, initialVersion );
	git( repo, 'add', '.' );
	git( repo, 'commit', '-qm', 'initial' );
	return repo;
}

function commitVersion( repo, version ) {
	writePlugin( repo, version );
	git( repo, 'add', '.' );
	git( repo, 'commit', '-qm', `version ${ version }` );
	return git( repo, 'rev-parse', 'HEAD' );
}

test( 'detects a Version header change across the complete push range', () => {
	const repo = createRepository();
	const before = git( repo, 'rev-parse', 'HEAD' );
	const current = commitVersion( repo, '0.5.2' );
	assert.deepEqual( detectRelease( { repoRoot: repo, beforeSha: before, expectedSha: current } ), {
		release: true,
		version: '0.5.2',
		previousVersion: '0.1.0',
		tag: 'wp-collab-cf-v0.5.2',
	} );
} );

test( 'does not release when the Version header is unchanged', () => {
	const repo = createRepository();
	const before = git( repo, 'rev-parse', 'HEAD' );
	fs.writeFileSync( path.join( repo, 'README.md' ), 'no version change\n' );
	git( repo, 'add', 'README.md' );
	git( repo, 'commit', '-qm', 'docs' );
	const current = git( repo, 'rev-parse', 'HEAD' );
	assert.deepEqual( detectRelease( { repoRoot: repo, beforeSha: before, expectedSha: current } ), {
		release: false,
		version: '0.1.0',
		previousVersion: '0.1.0',
		tag: null,
	} );
} );

test( 'treats an all-zero before SHA as the intentional first release', () => {
	const repo = createRepository( '0.5.2' );
	const current = git( repo, 'rev-parse', 'HEAD' );
	const result = detectRelease( { repoRoot: repo, beforeSha: ZERO_SHA, expectedSha: current } );
	assert.equal( result.release, true );
	assert.equal( result.previousVersion, null );
	assert.equal( result.tag, 'wp-collab-cf-v0.5.2' );
} );

test( 'fails closed when a nonzero before commit is unavailable', () => {
	const repo = createRepository();
	const current = git( repo, 'rev-parse', 'HEAD' );
	assert.throws(
		() => detectRelease( { repoRoot: repo, beforeSha: 'f'.repeat( 40 ), expectedSha: current } ),
		/Before commit .* is unavailable/
	);
} );

test( 'fails closed when the before commit is not an ancestor of the checkout', () => {
	const repo = createRepository();
	const common = git( repo, 'rev-parse', 'HEAD' );
	git( repo, 'checkout', '-qb', 'before-side' );
	const before = commitVersion( repo, '0.2.0' );
	git( repo, 'checkout', '-q', '--detach', common );
	const current = commitVersion( repo, '0.5.2' );
	assert.throws(
		() => detectRelease( { repoRoot: repo, beforeSha: before, expectedSha: current } ),
		/not an ancestor/
	);
} );

test( 'rejects malformed and contradictory source versions', () => {
	const fixture = fs.mkdtempSync( path.join( TEST_ROOT, 'version-' ) );
	assert.throws( () => readSourceVersion( writePlugin( fixture, 'bad version' ) ), /tag-safe/ );
	assert.throws( () => readSourceVersion( writePlugin( fixture, '0.5.2', '0.5.1' ) ), /WP_COLLAB_CF_VERSION/ );
	assert.throws( () => readSourceVersion( writePlugin( fixture, '0.5.2', '0.5.2', '0.5.1' ) ), /package.json/ );

	const repo = createRepository();
	const before = git( repo, 'rev-parse', 'HEAD' );
	writePlugin( repo, 'bad version' );
	git( repo, 'add', '.' );
	git( repo, 'commit', '-qm', 'malformed version' );
	assert.throws(
		() => detectRelease( { repoRoot: repo, beforeSha: before, expectedSha: git( repo, 'rev-parse', 'HEAD' ) } ),
		/tag-safe/
	);
} );

function assetFixture() {
	const dir = fs.mkdtempSync( path.join( TEST_ROOT, 'assets-' ) );
	const paths = [
		path.join( dir, 'wp-collab-cf-0.5.2-0123456789ab.zip' ),
		path.join( dir, 'wp-collab-cf-0.5.2-0123456789ab.zip.sha256' ),
		path.join( dir, 'plugin-artifact-manifest.json' ),
	];
	paths.forEach( ( file, index ) => fs.writeFileSync( file, `asset-${ index }\n` ) );
	return paths;
}

function releaseInput( assets = assetFixture() ) {
	return {
		repository: 'owner/repo',
		sha: '0123456789abcdef0123456789abcdef01234567',
		tag: 'wp-collab-cf-v0.5.2',
		version: '0.5.2',
		assets,
	};
}

function remoteAsset( file ) {
	const bytes = fs.readFileSync( file );
	return {
		id: Number.parseInt( crypto.createHash( 'sha256' ).update( file ).digest( 'hex' ).slice( 0, 8 ), 16 ),
		name: path.basename( file ),
		state: 'uploaded',
		size: bytes.length,
		digest: `sha256:${ crypto.createHash( 'sha256' ).update( bytes ).digest( 'hex' ) }`,
	};
}

class FakeGateway {
	constructor() {
		this.ref = null;
		this.release = null;
		this.assets = [];
		this.failUploadOnce = false;
		this.raceTagCreation = false;
		this.raceDraftCreation = false;
		this.raceAssetUpload = false;
		this.corruptUploadedDigest = false;
		this.tagReads = 0;
		this.moveTagOnRead = null;
		this.uploadCalls = [];
	}

	async getTagRef() {
		this.tagReads++;
		if ( this.moveTagOnRead === this.tagReads && this.ref ) {
			return { ...this.ref, object: { sha: 'f'.repeat( 40 ) } };
		}
		return this.ref;
	}
	async createTagRef( tag, sha ) {
		this.ref = { ref: `refs/tags/${ tag }`, object: { sha } };
		if ( this.raceTagCreation ) {
			this.raceTagCreation = false;
			throw new HttpError( 422, 'reference already exists' );
		}
		return this.ref;
	}
	async getRelease() { return this.release; }
	async createDraft( spec ) {
		this.release = {
			id: 7,
			...spec,
			// GitHub may report the default branch because target_commitish is
			// unused once the workflow has created the tag itself.
			target_commitish: 'main',
			draft: true,
			prerelease: false,
		};
		if ( this.raceDraftCreation ) {
			const outcome = this.raceDraftCreation;
			this.raceDraftCreation = false;
			if ( outcome === 'absent' ) this.release = null;
			if ( outcome === 'conflicting' ) this.release = { ...this.release, body: 'conflicting' };
			throw new HttpError( 422, 'release already exists' );
		}
		return this.release;
	}
	async listAssets() { return this.assets; }
	async uploadAsset( releaseId, file ) {
		assert.equal( releaseId, this.release.id );
		const asset = remoteAsset( file );
		this.uploadCalls.push( asset.name );
		const uploaded = this.corruptUploadedDigest
			? { ...asset, digest: `sha256:${ '0'.repeat( 64 ) }` }
			: asset;
		this.assets.push( uploaded );
		if ( this.raceAssetUpload ) {
			this.raceAssetUpload = false;
			throw new HttpError( 422, 'asset already exists' );
		}
		if ( this.failUploadOnce ) {
			this.failUploadOnce = false;
			throw new Error( 'simulated upload interruption' );
		}
		return uploaded;
	}
	async publishDraft() {
		this.release = { ...this.release, draft: false };
		return this.release;
	}
}

test( 'resumes a partially uploaded matching draft and publishes exact assets', async () => {
	const gateway = new FakeGateway();
	const input = releaseInput();
	gateway.failUploadOnce = true;
	await assert.rejects( reconcilePluginRelease( input, gateway ), /upload interruption/ );
	assert.equal( gateway.release.draft, true );
	assert.equal( gateway.assets.length, 1 );
	const result = await reconcilePluginRelease( input, gateway );
	assert.equal( result.status, 'published' );
	assert.equal( gateway.release.draft, false );
	assert.deepEqual(
		gateway.assets.map( ( asset ) => asset.name ).sort(),
		input.assets.map( ( file ) => path.basename( file ) ).sort()
	);
	assert.equal(
		gateway.uploadCalls.filter( ( name ) => name === path.basename( input.assets[ 0 ] ) ).length,
		1,
		'A successful asset from the interrupted attempt must not be replaced.'
	);
	const rerun = await reconcilePluginRelease( input, gateway );
	assert.equal( rerun.status, 'already-published' );
} );

test( 'recovers draft and asset creation races only when the resulting state matches', async () => {
	const draftRace = new FakeGateway();
	draftRace.raceDraftCreation = true;
	assert.equal( ( await reconcilePluginRelease( releaseInput(), draftRace ) ).status, 'published' );

	const assetRace = new FakeGateway();
	assetRace.raceAssetUpload = true;
	assert.equal( ( await reconcilePluginRelease( releaseInput(), assetRace ) ).status, 'published' );

	const conflictingRace = new FakeGateway();
	conflictingRace.raceAssetUpload = true;
	conflictingRace.corruptUploadedDigest = true;
	await assert.rejects( reconcilePluginRelease( releaseInput(), conflictingRace ), /digest/ );

	const absentDraftRace = new FakeGateway();
	absentDraftRace.raceDraftCreation = 'absent';
	await assert.rejects( reconcilePluginRelease( releaseInput(), absentDraftRace ), /still absent/ );

	const conflictingDraftRace = new FakeGateway();
	conflictingDraftRace.raceDraftCreation = 'conflicting';
	await assert.rejects( reconcilePluginRelease( releaseInput(), conflictingDraftRace ), /does not match/ );
} );

test( 'recovers an atomic tag-creation race only when the target matches', async () => {
	const gateway = new FakeGateway();
	gateway.raceTagCreation = true;
	const result = await reconcilePluginRelease( releaseInput(), gateway );
	assert.equal( result.status, 'published' );
} );

test( 'rejects wrong-target tags and conflicting drafts', async () => {
	const input = releaseInput();
	const wrongTag = new FakeGateway();
	wrongTag.ref = { ref: `refs/tags/${ input.tag }`, object: { sha: 'f'.repeat( 40 ) } };
	await assert.rejects( reconcilePluginRelease( input, wrongTag ), /does not target/ );

	const wrongDraft = new FakeGateway();
	wrongDraft.ref = { ref: `refs/tags/${ input.tag }`, object: { sha: input.sha } };
	wrongDraft.release = {
		id: 8,
		tag_name: input.tag,
		target_commitish: 'f'.repeat( 40 ),
		name: 'WP Collab Cloudflare 0.5.2',
		body: 'conflicting',
		draft: true,
		prerelease: false,
	};
	await assert.rejects( reconcilePluginRelease( input, wrongDraft ), /does not match/ );
} );

test( 'rejects incomplete published releases and provenance mismatches', async () => {
	const input = releaseInput();
	const incomplete = new FakeGateway();
	incomplete.ref = { ref: `refs/tags/${ input.tag }`, object: { sha: input.sha } };
	incomplete.release = {
		id: 9,
		tag_name: input.tag,
		target_commitish: input.sha,
		name: 'WP Collab Cloudflare 0.5.2',
		body: RELEASE_BODY,
		draft: false,
		prerelease: false,
	};
	incomplete.assets = input.assets.slice( 0, 1 ).map( remoteAsset );
	await assert.rejects( reconcilePluginRelease( input, incomplete ), /exact release asset set/ );

	const corrupt = new FakeGateway();
	corrupt.corruptUploadedDigest = true;
	await assert.rejects( reconcilePluginRelease( input, corrupt ), /digest/ );
	assert.equal( corrupt.release.draft, true );
} );

test( 'rejects mismatched or incomplete existing draft assets without replacing them', async () => {
	const input = releaseInput();
	for ( const asset of [
		{ ...remoteAsset( input.assets[ 0 ] ), digest: `sha256:${ '0'.repeat( 64 ) }` },
		{ ...remoteAsset( input.assets[ 0 ] ), state: 'new' },
	] ) {
		const gateway = new FakeGateway();
		gateway.ref = { ref: `refs/tags/${ input.tag }`, object: { sha: input.sha } };
		await gateway.createDraft( {
			tag_name: input.tag,
			target_commitish: input.sha,
			name: 'WP Collab Cloudflare 0.5.2',
			body: RELEASE_BODY,
			draft: true,
			prerelease: false,
		} );
		gateway.assets = [asset];
		await assert.rejects( reconcilePluginRelease( input, gateway ), /digest|state/ );
		assert.deepEqual( gateway.uploadCalls, [] );
	}
} );

test( 're-reads the exact tag immediately before and after publication', async () => {
	const beforePublish = new FakeGateway();
	beforePublish.moveTagOnRead = 2;
	await assert.rejects( reconcilePluginRelease( releaseInput(), beforePublish ), /does not target/ );
	assert.equal( beforePublish.release.draft, true );

	const afterPublish = new FakeGateway();
	afterPublish.moveTagOnRead = 3;
	await assert.rejects( reconcilePluginRelease( releaseInput(), afterPublish ), /does not target/ );
	assert.equal( afterPublish.release.draft, false );
} );

function includedResponse( status, body ) {
	const reason = status === 200 ? 'OK' : status === 201 ? 'Created' : status === 404 ? 'Not Found' : 'Error';
	return {
		status: status >= 200 && status < 300 ? 0 : 1,
		stdout: `HTTP/2.0 ${ status } ${ reason }\r\ncontent-type: application/json\r\n\r\n${ JSON.stringify( body ) }\n`,
		stderr: '',
	};
}

test( 'the gh adapter finds exact-tag drafts through authenticated pagination', async () => {
	const calls = [];
	const draft = { id: 42, tag_name: 'wp-collab-cf-v0.5.2', draft: true };
	const gateway = new GitHubGateway( {
		repository: 'owner/repo',
		spawnSyncImpl: ( command, args ) => {
			assert.equal( command, 'gh' );
			const endpoint = args[ 4 ];
			calls.push( endpoint );
			if ( endpoint.includes( '/releases/tags/' ) ) return includedResponse( 404, { message: 'Not Found' } );
			if ( endpoint.endsWith( 'page=1' ) ) {
				return includedResponse( 200, Array.from( { length: 100 }, ( _, index ) => ( {
					id: index + 1,
					tag_name: `other-${ index }`,
					draft: true,
				} ) ) );
			}
			return includedResponse( 200, [draft] );
		},
	} );
	assert.deepEqual( await gateway.getRelease( draft.tag_name ), draft );
	assert.match( calls[ 1 ], /releases\?per_page=100&page=1$/ );
	assert.match( calls[ 2 ], /releases\?per_page=100&page=2$/ );
} );

test( 'the gh adapter rejects duplicate drafts, API failure, and pagination overflow', async () => {
	const tag = 'wp-collab-cf-v0.5.2';
	const absent = new GitHubGateway( {
		repository: 'owner/repo',
		spawnSyncImpl: ( _command, args ) => args[ 4 ].includes( '/releases/tags/' )
			? includedResponse( 404, { message: 'Not Found' } )
			: includedResponse( 200, [] ),
	} );
	assert.equal( await absent.getRelease( tag ), null );

	const duplicate = new GitHubGateway( {
		repository: 'owner/repo',
		spawnSyncImpl: ( _command, args ) => args[ 4 ].includes( '/releases/tags/' )
			? includedResponse( 404, { message: 'Not Found' } )
			: includedResponse( 200, [
				{ id: 1, tag_name: tag, draft: true },
				{ id: 2, tag_name: tag, draft: true },
			] ),
	} );
	await assert.rejects( duplicate.getRelease( tag ), /multiple GitHub releases/ );

	const apiFailure = new GitHubGateway( {
		repository: 'owner/repo',
		spawnSyncImpl: ( _command, args ) => args[ 4 ].includes( '/releases/tags/' )
			? includedResponse( 404, { message: 'Not Found' } )
			: includedResponse( 503, { message: 'try later' } ),
	} );
	await assert.rejects( apiFailure.getRelease( tag ), /HTTP 503/ );

	const overflow = new GitHubGateway( {
		repository: 'owner/repo',
		maxPages: 2,
		spawnSyncImpl: () => includedResponse( 200, Array.from( { length: 100 }, ( _, id ) => ( { id } ) ) ),
	} );
	await assert.rejects( overflow.listAssets( 7 ), /page limit/ );
} );

test( 'the gh adapter returns asset conflicts from later pages', async () => {
	const calls = [];
	const conflict = { id: 1001, name: 'conflict.zip', state: 'uploaded', size: 1, digest: `sha256:${ '0'.repeat( 64 ) }` };
	const gateway = new GitHubGateway( {
		repository: 'owner/repo',
		spawnSyncImpl: ( _command, args ) => {
			const endpoint = args[ 4 ];
			calls.push( endpoint );
			return endpoint.endsWith( 'page=1' )
				? includedResponse( 200, Array.from( { length: 100 }, ( _, id ) => ( { id, name: `asset-${ id }` } ) ) )
				: includedResponse( 200, [conflict] );
		},
	} );
	const assets = await gateway.listAssets( 7 );
	assert.equal( assets.length, 101 );
	assert.deepEqual( assets.at( -1 ), conflict );
	assert.match( calls.at( -1 ), /page=2$/ );
} );

test( 'the gh adapter distinguishes HTTP absence from API or network failure', async () => {
	const calls = [];
	const absent = new GitHubGateway( {
		repository: 'owner/repo',
		spawnSyncImpl: ( command, args ) => {
			calls.push( [command, ...args] );
			return { status: 1, stdout: 'HTTP/2.0 404 Not Found\r\ncontent-type: application/json\r\n\r\n{"message":"Not Found"}\n', stderr: '' };
		},
	} );
	assert.equal( await absent.getTagRef( 'wp-collab-cf-v0.5.2' ), null );
	assert.deepEqual( calls[ 0 ].slice( 0, 5 ), [
		'gh', 'api', '--include', '--method', 'GET',
	] );

	const networkFailure = new GitHubGateway( {
		repository: 'owner/repo',
		spawnSyncImpl: () => ( { status: 1, stdout: '', stderr: 'network unavailable' } ),
	} );
	await assert.rejects( networkFailure.getTagRef( 'wp-collab-cf-v0.5.2' ), /network unavailable/ );

	const apiFailure = new GitHubGateway( {
		repository: 'owner/repo',
		spawnSyncImpl: () => ( {
			status: 1,
			stdout: 'HTTP/2.0 503 Service Unavailable\r\ncontent-type: application/json\r\n\r\n{"message":"try later"}\n',
			stderr: '',
		} ),
	} );
	await assert.rejects( apiFailure.getTagRef( 'wp-collab-cf-v0.5.2' ), /HTTP 503/ );

	const uploadCalls = [];
	const upload = new GitHubGateway( {
		repository: 'owner/repo',
		uploadRequestImpl: async ( request ) => {
			uploadCalls.push( request );
			return { id: 5 };
		},
	} );
	const file = assetFixture()[ 0 ];
	await upload.uploadAsset( 7, file );
	assert.deepEqual( uploadCalls, [{
		repository: 'owner/repo',
		releaseId: 7,
		file,
		token: process.env.GH_TOKEN,
	}] );
} );

test( 'direct asset upload authenticates to the numeric release endpoint', async () => {
	const file = assetFixture()[ 0 ];
	let observedOptions = null;
	const result = await uploadReleaseAsset( {
		repository: 'owner/repo',
		releaseId: 7,
		file,
		token: 'test-token',
		requestImpl: ( options, respond ) => {
			observedOptions = options;
			return new Writable( {
				write( _chunk, _encoding, callback ) { callback(); },
				final( callback ) {
					const response = new EventEmitter();
					response.statusCode = 201;
					respond( response );
					response.emit( 'data', Buffer.from( '{"id":7}' ) );
					response.emit( 'end' );
					callback();
				},
			} );
		},
	} );
	assert.deepEqual( result, { id: 7 } );
	assert.equal( observedOptions.hostname, 'uploads.github.com' );
	assert.equal( observedOptions.path, '/repos/owner/repo/releases/7/assets?name=wp-collab-cf-0.5.2-0123456789ab.zip' );
	assert.equal( observedOptions.headers.Authorization, 'Bearer test-token' );
	assert.equal( observedOptions.headers[ 'Content-Type' ], 'application/octet-stream' );
} );
