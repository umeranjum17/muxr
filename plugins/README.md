# Bundled muxr plugins

These packages install into Herdr during muxr setup. Each can have an optional Herdr backend and an optional muxr native UI contribution.

| Plugin | Backend | Mobile contribution |
|---|---|---|
| `control` | muxr control command | setup/control surface |
| `run-server` | starts the project's dev script + discovers project HTTP listeners | generic session-header `item-list` with validated preview-port actions |
| `voice` | machine-held realtime provider adapter | generic capability buttons, provider-neutral realtime overlay, declarative settings + voice shortcut |
| `inbox` | public session context RPC | Inbox tab using the source-driven `collection` primitive |
| `changes` | `git status` list RPC | session pill using `item-list` |
| `attachments` | dump-dir list RPC | session pill using `item-list` |
| `usage-status` | pinned offline ccusage + bounded Codex limits | generic read-only item list |
| `terminal-keys` | none | declarative terminal key row |
| `dictation` | none | home composer using `dictate` |
| `workspace-hierarchy` | public workspace-tree context RPC | session overlay using source-driven `tree-sheet` |
| `file-viewer` | read files in a herdr-known repo | Files destination using the bounded syntax-highlighted `code` node |
| `git-history` | `git log` / `git show` | session header button + screens |
| `ports` | list/stop listening processes | Ports destination |
| `runbook` | saved commands, then `execSync` | Runbook destination (remote shell) |
| `vitals` | disk/memory/load/uptime | Home machine card |
| `pane-titler` | rename panes from scrollback | backend only |
| `example-ui` | echo list/save RPCs | settings example for SDK validation |

Read [docs/PLUGINS.md](../docs/PLUGINS.md) before adding a package. Every plugin folder must contain a concise `README.md` covering its UI, backend execution, permissions, state/secrets, offline behavior, compatibility, and removal.

```bash
node scripts/cli.mjs plugin check plugins/<name>
```
