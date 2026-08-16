# Changes

Reads bounded `git status --porcelain` metadata for the current session through
a read-only `host.rpc`, then renders it with the generic `item-list` primitive
in `session.pills`. Tapping a row uses the validated current-session file action.

- **Phone:** a Changes pill and native item sheet with status icons and compact `+` / `−` metadata.
- **Host:** `rpc.mjs` returns at most 50 changed paths plus bounded staged/unstaged numstats; no patch bodies.
- **Authority:** one read RPC. No actions, startup hooks, panes, or secrets.
- **Offline:** cached items stay visible; a failed refresh shows retry state.
- **Removal:** `herdr plugin unlink muxr.changes`.
