# Worker dependency patches

## `y-partyserver@2.2.0`

`y-partyserver+2.2.0.patch` carries the focused `resetDocument()` lifecycle API
from [`lebdavis/partykit`'s `feat/yserver-reset-document` branch](https://github.com/lebdavis/partykit/tree/feat/yserver-reset-document).
It is applied by `patch-package` during installation so production and local
bundles use the same forked code while the upstream proposal is reviewed.

Remove the patch, `patch-package`, and the `postinstall` script after a released
`y-partyserver` version provides the same supported API. Keep the final-peer
runtime tests as the upgrade contract.
