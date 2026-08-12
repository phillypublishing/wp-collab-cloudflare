#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d)"
dirty_probe="${repo_root}/.plugin-artifact-dirty-probe"
trap 'rm -rf "${test_root}"; rm -f "${dirty_probe}"' EXIT

if [[ -e "${dirty_probe}" ]]; then
	echo "Refusing to overwrite existing dirty-checkout probe: ${dirty_probe}" >&2
	exit 1
fi

touch "${dirty_probe}"
if PLUGIN_ARTIFACT_ALLOW_DIRTY=0 \
	"${repo_root}/scripts/build-plugin-artifact.sh" "${test_root}/rejected" \
	> "${test_root}/dirty-guard.log" 2>&1; then
	echo 'Artifact builder accepted a dirty checkout.' >&2
	exit 1
fi
grep -Fq 'Refusing to package a dirty checkout.' "${test_root}/dirty-guard.log"
rm -f "${dirty_probe}"

export PLUGIN_ARTIFACT_ALLOW_DIRTY="${PLUGIN_ARTIFACT_ALLOW_DIRTY:-1}"

first_output_dir="${1:-${test_root}/first}"
TZ=UTC "${repo_root}/scripts/build-plugin-artifact.sh" "${first_output_dir}"
TZ=America/New_York "${repo_root}/scripts/build-plugin-artifact.sh" "${test_root}/second"

first_manifest="${first_output_dir}/plugin-artifact-manifest.json"
second_manifest="${test_root}/second/plugin-artifact-manifest.json"
first_artifact="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).artifact' "${first_manifest}")"
second_artifact="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).artifact' "${second_manifest}")"
first_zip="${first_output_dir}/${first_artifact}"
second_zip="${test_root}/second/${second_artifact}"

if [[ -z "${first_zip}" || -z "${second_zip}" ]]; then
	echo 'Expected both packaging runs to produce a ZIP.' >&2
	exit 1
fi

cmp "${first_zip}" "${second_zip}"

expected_entries="${test_root}/expected-entries"
actual_entries="${test_root}/actual-entries"
expected_build_entries="${test_root}/expected-build-entries"
actual_build_entries="${test_root}/actual-build-entries"
cat > "${expected_entries}" <<'EOF'
wp-collab-cf/build/index.asset.php
wp-collab-cf/build/index.js
wp-collab-cf/wp-collab-cf.php
EOF
cat > "${expected_build_entries}" <<'EOF'
index.asset.php
index.js
EOF
find "${repo_root}/plugin/wp-collab-cf/build" -type f -printf '%P\n' | sort > "${actual_build_entries}"
diff -u "${expected_build_entries}" "${actual_build_entries}"
unzip -Z1 "${first_zip}" > "${actual_entries}"
diff -u "${expected_entries}" "${actual_entries}"

node -e '
	const crypto = require( "node:crypto" );
	const fs = require( "node:fs" );
	const manifest = JSON.parse( fs.readFileSync( process.argv[ 1 ], "utf8" ) );
	const expected = fs.readFileSync( process.argv[ 2 ], "utf8" ).trimEnd().split( "\n" );
	const zip = process.argv[ 3 ];
	const expectedCommit = process.argv[ 4 ];
	const expectedBuiltAt = process.argv[ 5 ];
	const expectedRepository = process.argv[ 6 ];
	const expectedRef = process.argv[ 7 ];
	const expectedSha256 = crypto.createHash( "sha256" ).update( fs.readFileSync( zip ) ).digest( "hex" );
	const expectedArtifact = require( "node:path" ).basename( zip );
	if ( manifest.schema !== "wp-collab-cf-plugin-artifact/v1" ) {
		throw new Error( "Manifest schema is not recognized." );
	}
	if ( JSON.stringify( manifest.files ) !== JSON.stringify( expected ) ) {
		throw new Error( "Manifest files do not match the ZIP allowlist." );
	}
	for ( const [ field, actual, wanted ] of [
		[ "commit", manifest.commit, expectedCommit ],
		[ "artifact", manifest.artifact, expectedArtifact ],
		[ "sha256", manifest.sha256, expectedSha256 ],
		[ "builtAt", manifest.builtAt, expectedBuiltAt ],
		[ "repository", manifest.repository, expectedRepository ],
		[ "ref", manifest.ref, expectedRef ],
	] ) {
		if ( actual !== wanted ) {
			throw new Error( `Manifest ${ field } does not match the packaged source.` );
		}
	}
' \
	"${first_manifest}" \
	"${expected_entries}" \
	"${first_zip}" \
	"$(git -C "${repo_root}" rev-parse HEAD)" \
	"$(git -C "${repo_root}" show -s --format=%cI HEAD | node -p 'new Date(require("node:fs").readFileSync(0, "utf8").trim()).toISOString()')" \
	"${GITHUB_REPOSITORY:-local}" \
	"${GITHUB_REF_NAME:-$(git -C "${repo_root}" branch --show-current)}"

(
	cd "$(dirname "${first_zip}")"
	sha256sum --check "$(basename "${first_zip}").sha256"
)

echo 'Plugin artifact contract passed.'
