# Status

Coding-agent usage and machine vitals.

- **Usage:** exact pinned ccusage native binary with `daily --last 1 --by-agent --json --no-cost --offline`; only allowlisted agent names and rounded totals leave the machine. Codex limits come from its local app-server. Item rows plus a declarative detail screen with charts (UI v13).
- **Vitals:** disk, memory, load, and uptime of the machine running your agents.
- **Bounds:** read-only, 15s/8s subprocess deadlines, one-minute owner-only cache of the final bounded model. Costs, prompts, models, projects, and session details are never exposed.
- **Removal:** `herdr plugin unlink muxr.status`.
