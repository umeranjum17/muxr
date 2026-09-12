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
