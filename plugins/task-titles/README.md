# Task titles

`muxr.task-titles` is a Herdr event plugin. Once an agent reports `working` with a bound session, it reads the first user prompt from that agent's local transcript, extracts a short task phrase, and publishes Herdr pane title metadata. It never changes agent identity, pane labels, branches, or workspaces. Ambiguous prompts, missing transcripts, and unavailable Herdr leave the current title alone.

Settings and the hook share Herdr's owner-only `plugin config-dir muxr.task-titles`. `settings.json` contains only `{ "enabled": true|false }`; generation markers record only a hash, title, source, confidence, and time. The prompt text is not saved. `outcome.json` records the latest result. The host authenticates RPC callers and limits writes to control devices; `preview` is read-only and does not touch Herdr or disk.

When another active title writer such as `herdr-plugin-renamer` or `auto-namer` is installed, the hook reports a conflict and skips writes. Disable that writer deliberately before enabling Task titles. `animal-namer` is an agent identity writer and can coexist. Existing plugin roots, settings, branch prefixes, and titles are left in place.

Herdr has no atomic compare-and-set for pane title metadata. The hook serializes its own attempts per pane, re-reads the agent generation, title, name, and pane label immediately before publishing, and fails closed if any owner field changes. A competing writer that starts between the final read and Herdr's metadata write remains a platform limitation; the active-writer conflict check avoids known competing hooks.
