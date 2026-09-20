# Bundled muxr plugins

These packages install into Herdr during muxr setup. Each can have an optional Herdr backend and an optional muxr native UI contribution.

Product surfaces are not plugins: the muxr management pane pack (setup, pair,
doctor, service, self-host) lives in `resources/control/`, is versioned with
muxr, and `muxr setup` links it. Pane navigation and Applications on the phone
are product screens backed by typed host methods, not plugin contributions.

| Plugin | Backend | Mobile contribution |
|---|---|---|
| `voice` | machine-held realtime provider adapter | generic capability buttons, provider-neutral realtime overlay, declarative settings + voice shortcut |
| `status` | pinned offline ccusage + bounded plan limits (see `status/README.md`); disk/memory/load/uptime | Usage rows + chart detail screen; Home machine card |

Agent Names and Task Titles are Herdr fields. Muxr only displays them. Agents name
their own workspace and pane through the self-naming endpoint (see the Self-naming
section in the root `AGENTS.md` and `scripts/naming/README.md`); `animal-namer`
fills blank agent names as a fallback. Do not bundle or install a title-guessing
plugin such as `wyattjoh/herdr-plugin-renamer` — it was disabled on 2026-09-19
because it duplicates the self-naming endpoint.

Read [docs/PLUGINS.md](../docs/PLUGINS.md) before adding a package. Every plugin folder must contain a concise `README.md` covering its UI, backend execution, permissions, state/secrets, offline behavior, compatibility, and removal.

```bash
node scripts/cli.mjs plugin check plugins/<name>
```
