# Workspace Hierarchy

Transforms the host's bounded public `workspace-tree` context into generic `tree-sheet` nodes. The renderer presents titles/status/current state and dispatches validated session navigation; it no longer owns herdr RPCs, layout storage, split policy, or feature routes.

- **Host:** `rpc.mjs tree` receives the current muxr session id as input and `MUXR_PLUGIN_CONTEXT_JSON` because the manifest declares `context: ["workspace-tree"]`.
- **Current cut:** New tab, split, tab grid, save/restore layout, close/watch/focus actions are omitted until they fit declared write RPCs without exposing internal pane/tab/workspace ids.
- **Removal:** `herdr plugin unlink muxr.workspace-hierarchy`
