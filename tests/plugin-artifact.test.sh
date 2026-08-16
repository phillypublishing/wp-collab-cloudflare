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
node "${repo_root}/scripts/plugin-artifact.mjs" files > "${expected_entries}"
cat > "${expected_build_entries}" <<'EOF'
index.asset.php
index.js
EOF
find "${repo_root}/plugin/wp-collab-cf/build" -type f -printf '%P\n' | sort > "${actual_build_entries}"
diff -u "${expected_build_entries}" "${actual_build_entries}"
unzip -Z1 "${first_zip}" > "${actual_entries}"
diff -u "${expected_entries}" "${actual_entries}"

node "${repo_root}/scripts/plugin-artifact.mjs" verify "${first_output_dir}"
node "${repo_root}/scripts/plugin-artifact.mjs" verify "${test_root}/second"

manifest_mismatch="${test_root}/manifest-version-mismatch"
cp -a "${first_output_dir}" "${manifest_mismatch}"
node -e '
	const fs = require( "node:fs" );
	const file = process.argv[ 1 ];
	const manifest = JSON.parse( fs.readFileSync( file, "utf8" ) );
	manifest.pluginVersion = "0.0.0-mismatch";
	fs.writeFileSync( file, `${ JSON.stringify( manifest, null, 2 ) }\n` );
' "${manifest_mismatch}/plugin-artifact-manifest.json"
if node "${repo_root}/scripts/plugin-artifact.mjs" verify "${manifest_mismatch}" \
	> "${test_root}/manifest-version-mismatch.log" 2>&1; then
	echo 'Artifact verifier accepted a mismatched manifest version.' >&2
	exit 1
fi
grep -Fq 'Manifest pluginVersion does not match the source commit.' \
	"${test_root}/manifest-version-mismatch.log"

allowlist_mismatch="${test_root}/manifest-allowlist-mismatch"
cp -a "${first_output_dir}" "${allowlist_mismatch}"
node -e '
	const fs = require( "node:fs" );
	const file = process.argv[ 1 ];
	const manifest = JSON.parse( fs.readFileSync( file, "utf8" ) );
	manifest.files.pop();
	fs.writeFileSync( file, `${ JSON.stringify( manifest, null, 2 ) }\n` );
' "${allowlist_mismatch}/plugin-artifact-manifest.json"
if node "${repo_root}/scripts/plugin-artifact.mjs" verify "${allowlist_mismatch}" \
	> "${test_root}/manifest-allowlist-mismatch.log" 2>&1; then
	echo 'Artifact verifier accepted a mismatched manifest allowlist.' >&2
	exit 1
fi
grep -Fq 'Manifest files does not match the source commit.' \
	"${test_root}/manifest-allowlist-mismatch.log"

checksum_mismatch="${test_root}/checksum-mismatch"
cp -a "${first_output_dir}" "${checksum_mismatch}"
printf 'corrupt\n' > "${checksum_mismatch}/$(basename "${first_zip}").sha256"
if node "${repo_root}/scripts/plugin-artifact.mjs" verify "${checksum_mismatch}" \
	> "${test_root}/checksum-mismatch.log" 2>&1; then
	echo 'Artifact verifier accepted a mismatched checksum.' >&2
	exit 1
fi
grep -Fq 'Checksum does not match the source commit.' "${test_root}/checksum-mismatch.log"

(
	cd "$(dirname "${first_zip}")"
	sha256sum --check "$(basename "${first_zip}").sha256"
)

echo 'Plugin artifact contract passed.'
