#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function stripComment( value, line ) {
	let quote = null;
	for ( let index = 0; index < value.length; index++ ) {
		const character = value[ index ];
		if ( quote ) {
			if ( quote === '"' && character === '\\' ) {
				index++;
				continue;
			}
			if ( character === quote ) quote = null;
			continue;
		}
		if ( character === '"' || character === "'" ) {
			quote = character;
		} else if ( character === '#' && ( index === 0 || /\s/.test( value[ index - 1 ] ) ) ) {
			return value.slice( 0, index ).trimEnd();
		}
	}
	assert.equal( quote, null, `Unterminated quoted scalar on workflow line ${ line }.` );
	return value;
}

function scalar( value, line ) {
	if ( value === 'true' ) return true;
	if ( value === 'false' ) return false;
	if ( /^\d+$/.test( value ) ) return Number.parseInt( value, 10 );
	if ( ( value.startsWith( "'" ) && value.endsWith( "'" ) ) ||
		( value.startsWith( '"' ) && value.endsWith( '"' ) ) ) {
		return value.slice( 1, -1 );
	}
	assert.ok( ! /^[\[\]{&*!]|^>|^~$|^null$/i.test( value ), `Unsupported YAML scalar on workflow line ${ line }.` );
	return value;
}

function splitPair( text, line ) {
	const separator = text.indexOf( ':' );
	assert.notEqual( separator, -1, `Expected a mapping on workflow line ${ line }.` );
	const key = text.slice( 0, separator ).trim();
	assert.notEqual( key, '', `Empty mapping key on workflow line ${ line }.` );
	return [key, text.slice( separator + 1 ).trim()];
}

function parseWorkflowYaml( source ) {
	const tokens = source.split( '\n' ).flatMap( ( raw, index ) => {
		if ( raw.includes( '\t' ) ) throw new Error( `Tabs are not valid indentation on workflow line ${ index + 1 }.` );
		const indent = raw.match( /^ */ )[ 0 ].length;
		const text = stripComment( raw.slice( indent ), index + 1 );
		if ( text.trim() === '' ) return [];
		assert.equal( indent % 2, 0, `Workflow line ${ index + 1 } must use two-space indentation.` );
		return [{ indent, text, line: index + 1 }];
	} );
	let cursor = 0;

	function parseMap( indent, seed = {} ) {
		const result = seed;
		while ( cursor < tokens.length && tokens[ cursor ].indent === indent && ! tokens[ cursor ].text.startsWith( '- ' ) ) {
			const token = tokens[ cursor++ ];
			const [key, value] = splitPair( token.text, token.line );
			assert.ok( ! Object.hasOwn( result, key ), `Duplicate workflow key ${ key } on line ${ token.line }.` );
			if ( value === '|' ) {
				result[ key ] = parseLiteral( indent, token.line );
			} else if ( value === '' ) {
				assert.ok( cursor < tokens.length && tokens[ cursor ].indent > indent, `Missing value for ${ key } on line ${ token.line }.` );
				assert.equal( tokens[ cursor ].indent, indent + 2, `Unexpected indentation below ${ key } on line ${ token.line }.` );
				result[ key ] = parseBlock( indent + 2 );
			} else {
				result[ key ] = scalar( value, token.line );
			}
		}
		return result;
	}

	function parseLiteral( parentIndent, line ) {
		assert.ok( cursor < tokens.length && tokens[ cursor ].indent > parentIndent, `Missing block scalar on workflow line ${ line }.` );
		const contentIndent = parentIndent + 2;
		assert.equal( tokens[ cursor ].indent, contentIndent, `Unexpected block scalar indentation on workflow line ${ line }.` );
		const lines = [];
		while ( cursor < tokens.length && tokens[ cursor ].indent > parentIndent ) {
			const token = tokens[ cursor++ ];
			assert.ok( token.indent >= contentIndent, `Invalid block scalar indentation on workflow line ${ token.line }.` );
			lines.push( `${ ' '.repeat( token.indent - contentIndent ) }${ token.text }` );
		}
		return `${ lines.join( '\n' ) }\n`;
	}

	function parseList( indent ) {
		const result = [];
		while ( cursor < tokens.length && tokens[ cursor ].indent === indent && tokens[ cursor ].text.startsWith( '- ' ) ) {
			const token = tokens[ cursor++ ];
			const value = token.text.slice( 2 ).trim();
			if ( value.includes( ':' ) ) {
				const [key, firstValue] = splitPair( value, token.line );
				const item = { [ key ]: scalar( firstValue, token.line ) };
				result.push( parseMap( indent + 2, item ) );
			} else {
				result.push( scalar( value, token.line ) );
			}
		}
		return result;
	}

	function parseBlock( indent ) {
		assert.equal( tokens[ cursor ].indent, indent, `Unexpected indentation on workflow line ${ tokens[ cursor ].line }.` );
		return tokens[ cursor ].text.startsWith( '- ' ) ? parseList( indent ) : parseMap( indent );
	}

	const result = parseBlock( 0 );
	assert.equal( cursor, tokens.length, `Could not structurally parse workflow line ${ tokens[ cursor ]?.line }.` );
	return result;
}

assert.throws( () => parseWorkflowYaml( "name: 'unterminated\n" ), /Unterminated quoted scalar/ );
assert.throws( () => parseWorkflowYaml( 'name: [unsupported]\n' ), /Unsupported YAML scalar/ );

const repoRoot = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const workflowPath = path.join( repoRoot, '.github/workflows/wp-plugin-release.yml' );
const ciPath = path.join( repoRoot, '.github/workflows/ci.yml' );
const workflowSource = fs.readFileSync( workflowPath, 'utf8' );
const workflow = parseWorkflowYaml( workflowSource );

assert.deepEqual( Object.keys( workflow.on ), ['push'], 'Release workflow must expose only a push trigger.' );
assert.deepEqual( workflow.on.push.branches, ['main'], 'Release workflow must run only on main.' );
assert.deepEqual(
	workflow.on.push.paths,
	['plugin/wp-collab-cf/wp-collab-cf.php'],
	'Only a plugin source push may trigger the release workflow.'
);
assert.deepEqual( workflow.permissions, { contents: 'read' }, 'Top-level permissions must be read-only.' );
assert.deepEqual(
	workflow.concurrency,
	{
		group: 'wp-plugin-release',
		queue: 'max',
		'cancel-in-progress': false,
	},
	'Release runs must be serialized without dropping pending versions.'
);

const job = workflow.jobs.release;
assert.deepEqual( job.permissions, { contents: 'write' }, 'Only the release job may request contents write.' );
assert.equal( job.if, "github.ref == 'refs/heads/main'", 'Release job must guard the main ref.' );
assert.equal( job[ 'runs-on' ], 'ubuntu-latest', 'Release job must use the expected hosted runner.' );
assert.equal( job[ 'timeout-minutes' ], 15, 'Release job must have a bounded timeout.' );
assert.ok( ! Object.hasOwn( job.env ?? {}, 'GH_TOKEN' ), 'The write token must not be job-scoped.' );
assert.ok( ! JSON.stringify( job.env ?? {} ).includes( 'runner.temp' ), 'Runner context must not be evaluated at job scope.' );

const stepsByName = new Map( job.steps.map( ( step ) => [step.name, step] ) );
const checkout = stepsByName.get( 'Checkout release source' );
assert.match( checkout.uses, /@[0-9a-f]{40}$/, 'Checkout must be SHA-pinned.' );
assert.equal( checkout.with[ 'fetch-depth' ], 0, 'Release detection needs complete history.' );
assert.equal( checkout.with[ 'persist-credentials' ], false, 'Checkout must not persist a write credential.' );
for ( const action of job.steps.flatMap( ( step ) => step.uses ? [step.uses] : [] ) ) {
	assert.match( action, /@[0-9a-f]{40}$/, `Action is not SHA-pinned: ${ action }` );
}

const detect = stepsByName.get( 'Detect plugin Version header change' );
const install = stepsByName.get( 'Install plugin build dependencies' );
const build = stepsByName.get( 'Build and verify release assets' );
const publish = stepsByName.get( 'Publish GitHub Release' );
const pluginTest = stepsByName.get( 'Test plugin' );
const audit = stepsByName.get( 'Audit production dependencies' );
const lint = stepsByName.get( 'Lint plugin PHP' );
const diagnostics = stepsByName.get( 'Test plugin PHP diagnostics' );
const generatedLint = stepsByName.get( 'Lint generated plugin metadata' );
assert.equal( detect.run, 'node scripts/plugin-release.mjs detect', 'Version detection must use the executable helper.' );
assert.equal( detect.id, 'version', 'The release decision must own the version outputs.' );
assert.deepEqual( Object.keys( detect.env ), ['BEFORE_SHA'], 'Version detection must not receive a write token.' );
assert.equal( install.run, 'npm ci', 'Release dependencies must use npm ci.' );
assert.equal( pluginTest.run, 'npm test', 'Release publication must run plugin tests.' );
assert.equal( audit.run, 'npm audit --omit=dev --audit-level=high', 'Release publication must audit production dependencies.' );
assert.match( lint.run, /php -l wp-collab-cf\.php/, 'Release publication must lint the plugin entrypoint.' );
assert.match( lint.run, /includes\/compatibility/, 'Release publication must lint every compatibility module.' );
for ( const mode of ['rtc-diagnostics.php', 'compatibility-adapters.php', 'absent', 'mismatch', 'news-mismatch', 'news-missing'] ) {
	assert.ok( diagnostics.run.includes( mode ), `Release diagnostics must cover ${ mode }.` );
}
assert.equal( build.run, './scripts/build-plugin-artifact.sh "${ARTIFACT_DIR}"', 'Release must use the canonical artifact builder.' );
assert.equal( build.env.ARTIFACT_DIR, '${{ runner.temp }}/plugin-release', 'Artifact output must use step-scoped runner temp.' );
assert.equal( generatedLint.run, 'php -l plugin/wp-collab-cf/build/index.asset.php', 'Release must lint generated runtime metadata.' );
assert.equal( publish.run, 'node scripts/plugin-release.mjs publish "${ARTIFACT_DIR}"', 'Publishing must use the state machine.' );
assert.equal( publish.env.ARTIFACT_DIR, '${{ runner.temp }}/plugin-release', 'Publishing must reuse the step-scoped artifact path.' );
for ( const step of [install, pluginTest, audit, lint, diagnostics, build, generatedLint] ) {
	assert.ok( ! Object.hasOwn( step.env ?? {}, 'GH_TOKEN' ), `${ step.name } must not receive the write token.` );
}
assert.equal( publish.env.GH_TOKEN, '${{ github.token }}', 'Only the publish step may receive the write token.' );

const firstReleaseIndex = job.steps.findIndex( ( step ) => step.name === 'Set up Node.js' );
assert.notEqual( firstReleaseIndex, -1, 'Release workflow must contain the Set up Node.js anchor step.' );
assert.deepEqual(
	job.steps.slice( firstReleaseIndex ).map( ( step ) => step.name ),
	[
		'Set up Node.js',
		'Install plugin build dependencies',
		'Test plugin',
		'Audit production dependencies',
		'Lint plugin PHP',
		'Test plugin PHP diagnostics',
		'Build and verify release assets',
		'Lint generated plugin metadata',
		'Publish GitHub Release',
	],
	'All validation gates must run before artifact build and publication.'
);
for ( const step of job.steps.slice( firstReleaseIndex ) ) {
	assert.equal(
		step.if,
		"steps.version.outputs.release == 'true'",
		`${ step.name } must be gated by the executable release decision.`
	);
}

assert.ok( ! workflowSource.includes( 'git ls-remote' ), 'Workflow must not use a fail-open remote tag precheck.' );
assert.ok( ! workflowSource.includes( 'gh release create' ), 'Workflow must not use one-shot release creation.' );
assert.ok( ! workflowSource.includes( 'sha256sum --check' ), 'Artifact verification must not be duplicated inline.' );
assert.ok(
	fs.readFileSync( ciPath, 'utf8' ).includes( '- run: ./tests/plugin-release-workflow.test.sh' ),
	'CI must run the release workflow contract.'
);
