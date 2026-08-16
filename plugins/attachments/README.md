# Attachments

Lists metadata from the current pane's attachment directory through a read-only
`host.rpc`, then renders it with the generic `item-list` primitive in
`session.pills`. Tapping an item uses the kernel attachment action; transfer,
authorization, and encryption remain kernel-owned.

- **Phone:** a Files pill and native item sheet with MIME-aware row icons.
- **Host:** `rpc.mjs` returns at most 50 regular-file metadata records; no bytes.
- **Authority:** one read RPC. No actions, startup hooks, panes, or secrets.
- **Offline:** cached items stay visible; a failed refresh shows retry state.
- **Removal:** `herdr plugin unlink muxr.attachments`.
