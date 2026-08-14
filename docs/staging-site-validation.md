# Staging WordPress validation

This checklist validates an isolated Cloudflare staging Worker against a real
WordPress staging site without giving the Worker operator server access. Keep
the site-specific signing secret outside Git, chat, screenshots, and browser
developer tools.

## Install the exact plugin artifact

1. Open the successful **WordPress plugin artifact** run for the exact commit
   containing the plugin source you approved and download its
   `wp-collab-cf-<commit>` artifact. A later Worker-only deployment may use a
   different commit; record both commits separately.
2. Extract the Actions artifact locally. Verify the ZIP beside its checksum:

   ```bash
   sha256sum --check wp-collab-cf-*.zip.sha256
   ```

3. In WordPress, open **Plugins > Add Plugin > Upload Plugin**, upload the
   `wp-collab-cf-*.zip`, and activate **WP Collab Cloudflare**. Do not install
   the demo plugin on a staging or production site.
4. Add the private constants supplied by the Worker operator to the site's
   private `wp-config.php`, host-managed environment configuration, or an
   untracked mu-plugin. The required constants are:

   - `WP_ALLOW_COLLABORATION`
   - `WP_COLLAB_CF_WS_URL`
   - `WP_COLLAB_CF_SITE_ID`
   - `WP_COLLAB_CF_AUTH_SECRET`

   Define `WP_COLLAB_CF_AUTH_KEY_ID` only when `COLLAB_AUTH_KEYS` uses a named
   key. Leave it undefined for the supported legacy string entry.

   The site's canonical `admin_url()` origin must match the HTTPS origin seen
   in the browser. A proxy or domain mismatch is rejected deliberately.
5. Confirm real-time collaboration is enabled for the site. If the site was
   already using WordPress's polling collaboration transport, this setting is
   already satisfied. With WP-CLI, the explicit equivalent is:

   ```bash
   wp option update wp_collaboration_enabled 1
   ```

## Browser acceptance check

Use a disposable post and two distinct users who can edit it. Keep both editor
windows visible while running the checks.

If Gutenberg reports that the post uses incompatible plugins, open the browser
console and run `wpCollabCfDiagnostics.log()`. Record the sanitized blocker and
meta box tables. Do not mark a reported meta box compatible until its owner has
verified that concurrent editing cannot lose or overwrite its data.

- Type in editor A and confirm editor B converges; repeat in the other
  direction.
- Create, reply to, edit, resolve, reopen, and delete a Note. Confirm each
  operation appears in the other editor without reloading.
- Leave both editors connected for at least 75 seconds. The short-lived grant
  should expire without rotating the established WebSocket session. Neither
  editor should see a **Connection lost** notice or a collaborator
  **has left/has joined** pair.
- Save a non-baseline edit, close both editor windows, reopen the post, and
  confirm the saved document returns from WordPress.
- Reload each editor and confirm convergence resumes.
- Confirm a user who cannot edit the post cannot obtain a collaboration
  connection.

Record the WordPress and Gutenberg versions, plugin artifact commit and
checksum, browser names, approximate collaborator count, and every visible
disconnect or failed operation. Never include credentials, token response
bodies, or WebSocket subprotocol headers in the report.

## Rollback

Deactivate **WP Collab Cloudflare** first. WordPress then falls back to its
default collaboration provider. Remove the five private constants only after
the plugin is inactive. Do not delete the Cloudflare Durable Object namespace
as part of a site rollback.

If the plugin cannot be activated, remove its directory through the hosting
control panel. Existing post content and WordPress's `_crdt_document` snapshot
remain the durable authority; the staging Worker does not store document
bytes.
