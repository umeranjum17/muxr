# Bundled muxr plugins

These packages install into Herdr during muxr setup. Each can have an optional Herdr backend and an optional muxr native UI contribution.

| Plugin | Backend | Mobile contribution |
|---|---|---|
| `control` | muxr control command | setup/control surface |
| `voice` | machine-held realtime provider adapter | generic capability buttons, provider-neutral realtime overlay, declarative settings + voice shortcut |
| `inbox` | public session context RPC | Inbox tab using the source-driven `collection` primitive |
| `attachments` | dump-dir list RPC | session pill using `item-list` |
| `terminal-keys` | none | declarative terminal key row |
| `dictation` | none | home composer using `dictate` |
| `workspace-hierarchy` | public workspace-tree context RPC | session overlay using source-driven `tree-sheet` |
| `pane-titler` | rename panes from scrollback | backend only |
| `code` | bounded repo tree/preview, `git status`, `git log`/`show`, saved commands | Files explorer, Changes pill, Git history screens, Runbook destination |
| `status` | pinned offline ccusage + bounded Claude/Codex plan limits; disk/memory/load/uptime | Usage rows + chart detail screen; Home machine card |
| `servers` | list/stop listeners; start the project's dev script | Ports destination; Preview `item-list` with validated port actions |
| `example-ui` | echo list/save RPCs | settings example for SDK validation |

Read [docs/PLUGINS.md](../docs/PLUGINS.md) before adding a package. Every plugin folder must contain a concise `README.md` covering its UI, backend execution, permissions, state/secrets, offline behavior, compatibility, and removal.

```bash
node scripts/cli.mjs plugin check plugins/<name>
```
