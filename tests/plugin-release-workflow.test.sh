#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

node --test "${repo_root}/tests/plugin-release.test.mjs"
node "${repo_root}/tests/plugin-release-workflow.test.mjs"

echo 'Plugin release workflow contract passed.'
