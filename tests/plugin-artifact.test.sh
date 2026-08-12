#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "${test_root}"' EXIT

export PLUGIN_ARTIFACT_ALLOW_DIRTY=1
export PLUGIN_ARTIFACT_SOURCE_SHA=0000000000000000000000000000000000000000
export SOURCE_DATE_EPOCH=1770000000

"${repo_root}/scripts/build-plugin-artifact.sh" "${test_root}/first"
"${repo_root}/scripts/build-plugin-artifact.sh" "${test_root}/second"

first_zip="$(find "${test_root}/first" -maxdepth 1 -type f -name '*.zip' -print -quit)"
second_zip="$(find "${test_root}/second" -maxdepth 1 -type f -name '*.zip' -print -quit)"

if [[ -z "${first_zip}" || -z "${second_zip}" ]]; then
	echo 'Expected both packaging runs to produce a ZIP.' >&2
	exit 1
fi

cmp "${first_zip}" "${second_zip}"

expected_entries="${test_root}/expected-entries"
actual_entries="${test_root}/actual-entries"
cat > "${expected_entries}" <<'EOF'
wp-collab-cf/build/index.asset.php
wp-collab-cf/build/index.js
wp-collab-cf/wp-collab-cf.php
EOF
unzip -Z1 "${first_zip}" > "${actual_entries}"
diff -u "${expected_entries}" "${actual_entries}"

(
	cd "$(dirname "${first_zip}")"
	sha256sum --check "$(basename "${first_zip}").sha256"
)

echo 'Plugin artifact contract passed.'
