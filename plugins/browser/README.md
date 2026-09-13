# Browser

The packaged claimant for the provider-neutral `surface.browser.open`
capability: host-local web apps open through a leased Surface offer, never
through a terminal pane.

- **Descriptor:** read-only `browser.describe`. It names the capability and
  grants no browsing authority by itself; the host offer registry and the
  endpoint lease remain the authority.
- **Transport:** real WebView surfaces only. No PTY, no Kitty graphics, no
  host browser profile inheritance.
- **Removal:** `herdr plugin unlink muxr.browser`.
- **Preview origin:** `muxr browser open http://localhost:PORT/path`
  registers the loopback endpoint under the worktree and this provider and
  replies with the app's public preview *hostname* (never the port). Put
  that hostname in the framework's allowed dev origins (Next.js
  `allowedDevOrigins`, Expo `EXPO_PACKAGER_PROXY_URL=https://<hostname>`);
  `muxr browser origin [--name NAME]` prints it again. The renderer reaches
  the app only through the host's admission gateway over HTTPS.
