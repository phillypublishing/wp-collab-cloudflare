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

source_sha="$(git -C "${repo_root}" rev-parse HEAD)"
if [[ ! "${source_sha}" =~ ^[0-9a-f]{40}$ ]]; then
	echo 'The checked-out source must resolve to a full lowercase Git SHA.' >&2
	exit 1
fi

source_date_epoch="$(git -C "${repo_root}" show -s --format=%ct "${source_sha}")"
if [[ ! "${source_date_epoch}" =~ ^[0-9]+$ ]]; then
	echo 'The source commit timestamp must be a non-negative integer.' >&2
	exit 1
fi

for command_name in npm 7z sha256sum node touch install dirname unzip; do
	if ! command -v "${command_name}" >/dev/null 2>&1; then
		echo "Required packaging command is unavailable: ${command_name}" >&2
		exit 1
	fi
done

version="$(node "${repo_root}/scripts/plugin-artifact.mjs" version "${plugin_dir}")"

mkdir -p "${output_dir}"
output_dir="$(cd "${output_dir}" && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "${stage}"' EXIT

(
	cd "${plugin_dir}"
	npm run build
)

mapfile -t entries < <(node "${repo_root}/scripts/plugin-artifact.mjs" files)
if [[ "${#entries[@]}" -eq 0 ]]; then
	echo 'The plugin artifact allowlist is empty.' >&2
	exit 1
fi
for entry in "${entries[@]}"; do
	source_path="${plugin_dir}/${entry#wp-collab-cf/}"
	destination_path="${stage}/${entry}"
	install -d -m 0755 "$(dirname "${destination_path}")"
	install -m 0644 "${source_path}" "${destination_path}"
done

find "${stage}" -exec touch -d "@${source_date_epoch}" {} +

short_sha="${source_sha:0:12}"
artifact_name="wp-collab-cf-${version}-${short_sha}.zip"
artifact_path="${output_dir}/${artifact_name}"

rm -f "${artifact_path}" "${artifact_path}.sha256"
(
	cd "${stage}"
	export TZ=UTC
	7z a -bd -bso0 -bsp0 -tzip -mx=9 -mta=off -mtc=off -mtm=off \
		"${artifact_path}" "${entries[@]}"
)

(
	cd "${output_dir}"
	sha256sum "${artifact_name}" > "${artifact_name}.sha256"
)

read -r artifact_sha256 _ < "${artifact_path}.sha256"
artifact_files_json="$({ printf '%s\n' "${entries[@]}"; } | node -e '
	const fs = require( "node:fs" );
	const files = fs.readFileSync( 0, "utf8" ).trimEnd().split( "\n" );
	process.stdout.write( JSON.stringify( files ) );
')"
repository="${GITHUB_REPOSITORY:-local}"
ref_name="${GITHUB_REF_NAME:-$(git -C "${repo_root}" branch --show-current)}"
SOURCE_SHA="${source_sha}" \
	SOURCE_DATE_EPOCH="${source_date_epoch}" \
	PLUGIN_VERSION="${version}" \
	ARTIFACT_NAME="${artifact_name}" \
	ARTIFACT_SHA256="${artifact_sha256}" \
	ARTIFACT_FILES_JSON="${artifact_files_json}" \
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
	files: JSON.parse( process.env.ARTIFACT_FILES_JSON ),
};

fs.writeFileSync(
	process.env.MANIFEST_PATH,
	`${ JSON.stringify( manifest, null, 2 ) }\n`,
	{ mode: 0o644 }
);
NODE

node "${repo_root}/scripts/plugin-artifact.mjs" verify "${output_dir}"

printf 'Built %s\n' "${artifact_path}"
printf 'SHA-256 %s\n' "${artifact_sha256}"
