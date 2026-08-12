#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugin_dir="${repo_root}/plugin/wp-collab-cf"
output_dir="${1:-${repo_root}/dist}"

if [[ "${PLUGIN_ARTIFACT_ALLOW_DIRTY:-0}" != 1 ]] &&
	[[ -n "$(git -C "${repo_root}" status --porcelain --untracked-files=all)" ]]; then
	echo 'Refusing to package a dirty checkout. Commit the source or set PLUGIN_ARTIFACT_ALLOW_DIRTY=1 for local testing.' >&2
	exit 1
fi

source_sha="${PLUGIN_ARTIFACT_SOURCE_SHA:-$(git -C "${repo_root}" rev-parse HEAD)}"
if [[ ! "${source_sha}" =~ ^[0-9a-f]{40}$ ]]; then
	echo 'PLUGIN_ARTIFACT_SOURCE_SHA must be a full lowercase Git SHA.' >&2
	exit 1
fi

source_date_epoch="${SOURCE_DATE_EPOCH:-$(git -C "${repo_root}" show -s --format=%ct "${source_sha}")}"
if [[ ! "${source_date_epoch}" =~ ^[0-9]+$ ]]; then
	echo 'SOURCE_DATE_EPOCH must be a non-negative integer.' >&2
	exit 1
fi

version="$({
	grep -m1 -E '^[[:space:]]*\*[[:space:]]*Version:' "${plugin_dir}/wp-collab-cf.php" || true
} | sed -E 's/^[[:space:]]*\*[[:space:]]*Version:[[:space:]]*//; s/[[:space:]]*$//')"
if [[ -z "${version}" || ! "${version}" =~ ^[A-Za-z0-9._+-]+$ ]]; then
	echo 'Could not parse a filename-safe Version header from wp-collab-cf.php.' >&2
	exit 1
fi

for command_name in npm 7z sha256sum node touch; do
	if ! command -v "${command_name}" >/dev/null 2>&1; then
		echo "Required packaging command is unavailable: ${command_name}" >&2
		exit 1
	fi
done

mkdir -p "${output_dir}"
output_dir="$(cd "${output_dir}" && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "${stage}"' EXIT

(
	cd "${plugin_dir}"
	npm run build
)

install -d -m 0755 "${stage}/wp-collab-cf/build"
install -m 0644 "${plugin_dir}/wp-collab-cf.php" "${stage}/wp-collab-cf/wp-collab-cf.php"
install -m 0644 "${plugin_dir}/build/index.js" "${stage}/wp-collab-cf/build/index.js"
install -m 0644 "${plugin_dir}/build/index.asset.php" "${stage}/wp-collab-cf/build/index.asset.php"

find "${stage}" -exec touch -d "@${source_date_epoch}" {} +

short_sha="${source_sha:0:12}"
artifact_name="wp-collab-cf-${version}-${short_sha}.zip"
artifact_path="${output_dir}/${artifact_name}"
entries=(
	wp-collab-cf/build/index.asset.php
	wp-collab-cf/build/index.js
	wp-collab-cf/wp-collab-cf.php
)

rm -f "${artifact_path}" "${artifact_path}.sha256"
(
	cd "${stage}"
	7z a -bd -bso0 -bsp0 -tzip -mx=9 -mta=off -mtc=off -mtm=off \
		"${artifact_path}" "${entries[@]}"
)

(
	cd "${output_dir}"
	sha256sum "${artifact_name}" > "${artifact_name}.sha256"
)

artifact_sha256="$(sha256sum "${artifact_path}" | cut -d ' ' -f 1)"
repository="${GITHUB_REPOSITORY:-$(git -C "${repo_root}" remote get-url origin 2>/dev/null || printf 'local')}"
ref_name="${GITHUB_REF_NAME:-$(git -C "${repo_root}" branch --show-current)}"
SOURCE_SHA="${source_sha}" \
	SOURCE_DATE_EPOCH="${source_date_epoch}" \
	PLUGIN_VERSION="${version}" \
	ARTIFACT_NAME="${artifact_name}" \
	ARTIFACT_SHA256="${artifact_sha256}" \
	SOURCE_REPOSITORY="${repository}" \
	SOURCE_REF="${ref_name}" \
	MANIFEST_PATH="${output_dir}/plugin-artifact-manifest.json" \
	node <<'NODE'
const fs = require( 'node:fs' );

const manifest = {
	schema: 'wp-collab-cf-plugin-artifact/v1',
	repository: process.env.SOURCE_REPOSITORY,
	ref: process.env.SOURCE_REF,
	commit: process.env.SOURCE_SHA,
	pluginVersion: process.env.PLUGIN_VERSION,
	artifact: process.env.ARTIFACT_NAME,
	sha256: process.env.ARTIFACT_SHA256,
	builtAt: new Date(
		Number.parseInt( process.env.SOURCE_DATE_EPOCH, 10 ) * 1000
	).toISOString(),
	files: [
		'wp-collab-cf/wp-collab-cf.php',
		'wp-collab-cf/build/index.js',
		'wp-collab-cf/build/index.asset.php',
	],
};

fs.writeFileSync(
	process.env.MANIFEST_PATH,
	`${ JSON.stringify( manifest, null, 2 ) }\n`,
	{ mode: 0o644 }
);
NODE

printf 'Built %s\n' "${artifact_path}"
printf 'SHA-256 %s\n' "${artifact_sha256}"
