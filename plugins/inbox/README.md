# Inbox

Groups the host's bounded public session/attention context into the generic `collection` primitive. Grouping, waiting/working/done order, wording, and the six-hour done TTL live in this plugin; transport, notification permission, and the renderer stay kernel-owned.

- **Phone:** navigation item → `/plugin` with this plugin's content id; the manifest carries the shipped Inbox label and empty-state translations through the public UI 6 localized-text contract.
- **Host:** `rpc.mjs list` receives `MUXR_PLUGIN_CONTEXT_JSON` because the manifest declares `context: ["sessions"]`.
- **Privacy:** the context contains stable muxr session ids and display/status fields only — no pane/workspace/tab ids, terminal bytes, device ids, or secrets.
