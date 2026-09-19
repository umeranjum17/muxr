# Self-naming endpoint

One provider-agnostic naming system. The agent names its own workspace and pane
at task start; no watcher, no plugin, no prompt parsing.

```
POST /api/naming   {"pane_id":"w1:p2","workspace":"short-slug","pane":"Descriptive title","provider":"pi","model":"gemini-3-flash"}
```

- `workspace` → `herdr workspace rename` on the pane's workspace (`pane_id` before the colon).
- `pane` → `herdr pane rename` (the title muxr shows on the phone).
- `provider`/`model` → Herdr pane metadata tokens (`--source muxr.naming`) plus
  `~/.muxr/naming/state.json` for quota tooling such as quota-axi.
- Names pass through verbatim: no re-parsing, no stripping. Only bounds are
  enforced (64 KiB body, 512-char names, no leading `-`), by rejection, never by
  mutation.
- Loopback only (`127.0.0.1`), default port 8797 (`MUXR_NAMING_PORT`).
- `MUXR_NAMING_SESSION` appends `--session <name>` to every herdr call, so a lab
  instance can never touch another session.
- `HERDR_BIN` overrides the herdr binary (tests use a stub).

Lifecycle: `muxr up` (`scripts/setup/presentation/up.mjs`) spawns this beside
the relay and host. A naming crash degrades to the fallback namers; it never
takes the relay or host down.

Run the check: `node scripts/naming/naming.selfcheck.mjs` (real server, stub herdr).

## Disabled duplicate namers (2026-09-19)

- `herdr-plugin-renamer` — disabled. Guessed titles from the agent's first prompt.
- `auto-namer` — was already disabled. Same guessing approach (session titles, cwd workspaces).
- `animal-namer` — kept enabled as the fallback that only fills blank agent names.
- The bundled `muxr.pane-titler` was removed from this repo on 2026-08-30 and is not installed.
