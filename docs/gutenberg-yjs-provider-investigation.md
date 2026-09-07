# Gutenberg Yjs provider compatibility investigation

**Implementation update:** The backward-compatible change is now implemented
locally on this branch. The findings below describe the original 0.5.14 baseline.
The scratch reproduction probe has been replaced by positive regression tests
in `plugin/wp-collab-cf/test/provider-bundle.test.mjs` and PHP enqueue coverage
in `plugin/wp-collab-cf/test/rtc-diagnostics.php`. Release metadata is now bumped
to 0.5.15. The owner, currently the sole consumer, explicitly chose to perform
browser testing after release rather than gate the release on that check.

## Local implementation verification

- Clean `npm ci` succeeded against the updated lockfile. The three explicit
  test dependencies (`lib0`, `y-protocols`, and `webpack`) use already-resolved
  versions; no dependency version was upgraded.
- `npm test`: **64 passed, 0 failed**, including seven new production-bundle
  checks. The new-option and collection cases failed against the baseline
  before implementation; the legacy case passed.
- Production `npm run build` and targeted `wp-scripts lint-js` passed.
- `npm audit --omit=dev --audit-level=high`: **0 vulnerabilities**.
- Code review completed with **no actionable findings**, covering correctness,
  tests, the API contract, reliability, and an independent model pass. Receipt:
  `build/review/ce-code-review/yjs-compat-20260907/` (local ignored artifacts).
- PHP 8.3 lint, outage telemetry, RTC diagnostics/enqueue, compatibility adapters,
  and all eight compatibility version-policy scenarios passed. The enqueue
  contract also passed from a source-only snapshot without build assets, and
  its temporary manifest/build directory was removed afterward.
- PHP ran in a fresh container with networking disabled, a read-only mount of
  this worktree, and private temporary storage. No existing container or
  WordPress installation was used.
- Browser validation against a full Gutenberg #81999 installation remains an
  owner-run post-release check. The automated bundle tests exercise the proposed provider
  contract and real Yjs protocol operations without a live editor or Worker.

Investigated 2026-09-07 against `phillypublishing/wp-collab-cloudflare` main at
`e4bdc441f52ac6dd91f57c826dc6251e2201026b` (plugin 0.5.14).

## Recommendation

Prepare a backward-compatible plugin update before adopting Gutenberg's removal
of `wp.sync`. The current plugin cannot use the proposed provider interface.
The transport audit indicates this can be a plugin-only change; no Worker,
room protocol, authentication, or persistence change is required by these PRs.

## Upstream status and contract

- [VIP RTC #226](https://github.com/Automattic/vip-real-time-collaboration/pull/226)
  merged August 26, 2026, using a mutable Yjs shim and conditional `wp-sync`
  dependency. Reviewed head: `358019a9ae6a46d8caf998b6c1bf1742764c3c77`.
- [Gutenberg #81999](https://github.com/WordPress/gutenberg/pull/81999) remains
  open as of this investigation. Reviewed head:
  `eb12f920bd874576b6ca3f2843668c8aa05de6b8`. It removes the `wp-sync` script
  handle and `wp.sync` global and passes the editor's Yjs module as `Y` to
  both entity and collection provider creators. Do not assume a release version
  or merge date; use runtime capability detection.

## Local findings

| Location | Current behavior | Required adaptation |
| --- | --- | --- |
| `plugin/wp-collab-cf/wp-collab-cf.php`, `wp_collab_cf_enqueue_scripts()` | Always adds `wp-sync` to dependencies; an unregistered dependency prevents the plugin script from printing. This also affects UI and diagnostics in that bundle. | Preserve existing dependencies; append `wp-sync` only if `wp_script_is( 'wp-sync', 'registered' )`. |
| `plugin/wp-collab-cf/src/index.js`, `sync.providers` creator | Ignores the incoming `Y` option; returns an inert provider without credentials when `window.wp.sync.Y` is absent. | Prefer the passed `Y`, fall back to `window.wp?.sync?.Y`, and initialize the shim before credentials/provider construction. Keep a clear missing-module error and early return. |
| `plugin/wp-collab-cf/src/yjs-shim.js` | Captures the global once; constant exports stay undefined if loaded before Yjs is available. | Export live bindings and a setter for `Doc`, `applyUpdate`, `encodeStateVector`, and `encodeStateAsUpdate`. |
| `plugin/wp-collab-cf/webpack.config.js` | Already aliases `yjs` to the shim; its comment incorrectly says `globalThis.Yjs`. | Retain aliasing and correct the comment; verify the compiled bundle uses live bindings and contains no second Yjs implementation. |
| `README.md`, architecture step 2 | Describes only `wp.sync.Y`. | Document the provider option and legacy fallback. |

Changing just PHP or just the provider's guard is insufficient: all three
runtime integration points must change together. The inert result is not an
HTTP fallback: this plugin replaces the provider list with its own creator.

The installed browser transport is **y-partyserver 2.1.4**, unlike VIP's
y-websocket. Its provider imports `Doc`, used only inside the constructor's
`doc ?? new Doc()` fallback. Its y-protocols 1.0.7 dependency calls
`encodeStateVector`, `encodeStateAsUpdate`, and `applyUpdate` inside protocol
functions. No inspected Yjs call runs during module evaluation. A setter before
construction therefore fits this dependency graph. Keep all four exports and
recheck this property when dependencies change; the existing shim comment
claiming it is only for awareness type annotations is inaccurate.

## Evidence

- Installed the plugin's locked dependencies exclusively in this worktree.
- `npm test`: **57 passed, 0 failed**.
- `npm run build`: production webpack build succeeded.
- The initial scratch VM probe reproduced the failure in
  the actual production bundle with a VM and stubbed WordPress APIs. Legacy
  `wp.sync.Y` reached the stub credential call once. Passing `Y` without
  `wp.sync` made zero credential calls and logged the missing-global error.
  The probe also confirmed that loading the existing shim before Yjs leaves
  its exports undefined even after the global becomes available.
- Existing runtime tests import y-partyserver and real Yjs directly; they do
  not exercise the production entrypoint, webpack shim, or PHP enqueue path.
  Their passing baseline does not establish compatibility with the new API.

The initial probe asserted the original defect and has since been removed.
The production-bundle regressions exercise real Yjs sync with simulated sockets
and credentials; PHP tests exercise the enqueue function with WordPress stubs.
Neither makes network requests. No browser or end-to-end compatibility claim
is made.

## Validation for the update

1. Test the built bundle with no `wp.sync` at load time and a real `Y` supplied
   at creator invocation. Exercise sync step 1, step 2, and update application,
   including collections with `objectId: null` and no supplied awareness.
2. Cover legacy-global operation, provider-option precedence when both exist,
   and neither-source handling before credential/socket work.
3. Test PHP enqueue dependencies with `wp-sync` registered and absent.
4. Check webpack output/module stats for shared Yjs and run the plugin suite,
   build, and relevant PHP tests.
5. In a separately provisioned environment, test two editors on current
   supported Gutenberg and the reviewed PR: bidirectional editing, presence,
   undo/redo, save/reload, collections, and reconnect. Use separate ports,
   database, Docker project, and Worker configuration from the Copyeditor POC.

## Workspace and scope

Worktree: `/docker/worktrees/wp-collab-yjs-provider`.
Branch: `investigate/gutenberg-yjs-provider`, based on latest `origin/main`.
Implementation, documentation, and tests are confined to this worktree. Release
metadata targets 0.5.15, with publication triggered by merging the PR to main.
The active AI Copyeditor checkout and its submodule working files were not
edited or switched. Commits and publication use the isolated feature branch;
shared WordPress services and the deployed Worker remain untouched.
