# Bundled muxr plugins

These packages install into Herdr during muxr setup. Each can have an optional Herdr backend and an optional muxr native UI contribution.

| Plugin | Backend | Mobile contribution |
|---|---|---|
| `control` | muxr control command | setup/control surface |
| `voice` | machine-held realtime provider adapter | generic capability buttons, provider-neutral realtime overlay, declarative settings + voice shortcut |
| `attachments` | dump-dir list RPC | session pill using `item-list` |
| `terminal-keys` | none | declarative terminal key row |
| `dictation` | none | home composer using `dictate` |
| `workspace-hierarchy` | public workspace-tree context RPC | session overlay using source-driven `tree-sheet` |
| `code` | bounded repo tree, `git status`, `git log`/`show` | Files explorer, Changes pill, Git history screens |
| `panes` | Herdr pane/tool catalog + launch | Tools chip (Running / Terminal apps / Plugin tools / Plugin commands) and Panes destination |
| `status` | pinned offline ccusage + bounded Claude/Codex plan limits; disk/memory/load/uptime | Usage rows + chart detail screen; Home machine card |

Agent names and task titles come from Herdr. muxr does not bundle a naming writer. Automatic titles are available through optional third-party Herdr extensions such as [`wyattjoh/herdr-plugin-renamer`](https://github.com/wyattjoh/herdr-plugin-renamer).

Read [docs/PLUGINS.md](../docs/PLUGINS.md) before adding a package. Every plugin folder must contain a concise `README.md` covering its UI, backend execution, permissions, state/secrets, offline behavior, compatibility, and removal.

```bash
node scripts/cli.mjs plugin check plugins/<name>
```
