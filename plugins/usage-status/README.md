# Usage status

Read-only coding-agent usage item sheet.

- **Local activity:** runs the exact pinned [ccusage](https://github.com/ccusage/ccusage) native binary with `daily --last 1 --by-agent --json --no-cost --offline`. It reads local coding-agent logs, makes no model or pricing request, and returns only allowlisted agent names plus rounded total-token counts.
- **Current Codex limits:** queries the installed Codex local app-server API and renders only bounded percentages and reset times.
- **Installed agents:** PATH-only detection lists every known installed CLI. Agents absent from today's ccusage rows are labeled either “no activity reported” or “local totals unsupported by ccusage”; muxr never invokes those CLIs.
- **Bounds:** ccusage gets 15 seconds in parallel with Codex's 8-second call, each subprocess output is capped at 64 KiB, and timeout/error falls back without breaking the card.
- **State/secrets:** keeps only a one-minute owner-only cache of the final bounded item model and receives the plugin runner's restricted `HOME`, `PATH`, and `MUXR_*` environment. Cost fields and model/session details are never cached or rendered.
- **Offline:** local activity uses ccusage's offline mode; missing binaries or logs degrade to live limits and availability rows.
