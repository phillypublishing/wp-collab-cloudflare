# Plugin dependency patches

## `y-partyserver@2.1.4`

The provider's browser ESM entry registers an `unload` listener during
construction. With `Permissions-Policy: unload=()`, Chrome reports a violation
and ignores the registration, so the departure handler cannot clear presence.

`y-partyserver+2.1.4.patch` moves that cleanup to `pagehide`. A cached page saves
its local awareness state before departure and restores it on a persisted
`pageshow`; ordinary navigation and providers with no local presence do not
restore state. Destroy removes both listeners. The Node process exit handler
is preserved.

The patch applies only to `dist/provider/index.js`, the ESM entry consumed by
the plugin's webpack build. The unused CommonJS and React entries are unchanged.
`patch-package --error-on-fail` applies it during installation and fails the
install if an upgrade makes the patch incompatible.

Remove this patch, `patch-package`, and the `postinstall` script when the plugin
uses a released provider with equivalent lifecycle handling. Keep the production
bundle lifecycle tests in `test/provider-bundle.test.mjs` as the upgrade contract.

See [Chrome's unload migration guidance](https://developer.chrome.com/docs/web-platform/deprecating-unload).
