# Herdr orchestration: workspaces, panes, agents, worktrees

Drive Herdr (the terminal workspace manager muxr is built on) from the CLI or
its socket API — create workspaces/tabs/panes, start and orchestrate coding
agents, read pane output and scrollback, wait on lifecycle or output.

Use this when controlling Herdr: creating workspaces/tabs/panes, launching or
prompting coding agents in panes, reading terminal output or agent transcripts,
waiting on an agent to finish or for text to appear, or integrating an app
against the Herdr socket API (`~/.config/herdr/herdr.sock`). Also when a Herdr
call returns an unexpected empty result or an `agent_not_idle` /
`single_pane` style outcome. Not for ordinary local shell work with no Herdr
involvement.

Prefer Herdr panes over ephemeral in-process subagents when work should be
persistent, parallel, or visible in muxr — a pane survives your session and
shows up on the phone; an in-process subagent does not.

If commands here drift from your installed Herdr, `herdr --skill` prints that
binary's own version-matched skill.

## Spawning things from inside a pane (the common ask)

Every Herdr pane exports `HERDR_PANE_ID` (e.g. `w2A:p4`). That one value is the
whole map: **workspace id = `${HERDR_PANE_ID%%:*}`** (the part before the
colon), and `herdr pane get $HERDR_PANE_ID` returns `.result.pane.tab_id` +
`.result.pane.workspace_id`. Recipes:

- **New tab with an agent, same workspace + cwd:**
  `herdr tab create --workspace ${HERDR_PANE_ID%%:*} --cwd "$PWD" --label <name> --no-focus` → take `.result.root_pane.pane_id` → `herdr agent start <name> --kind <pi|claude|codex|...> --pane <pane_id> --timeout 60000`.
- **Split MY pane with an agent beside it:**
  `herdr pane split $HERDR_PANE_ID --direction right --no-focus` → `.result.pane.pane_id` → `herdr agent start <name> --kind <kind> --pane <pane_id> --timeout 60000`.
- **Fresh workspace + agent elsewhere:**
  `herdr workspace create --cwd <dir> --label <name> --no-focus` → `.result.root_pane.pane_id` → `agent start` as above.
- **Isolated git worktree:**
  `herdr worktree create --cwd <repo> --branch <name>` → use the returned checkout as the cwd for workspace/tab create.
- **Give it work:** `herdr agent prompt <name> "<task>" --wait --timeout 300000`. `--wait` blocks until idle/done/blocked; always pass a timeout.
- **Check on it:** `herdr agent get <name>` / `herdr agent list`; read output with `herdr pane read <pane_id> --source recent-unwrapped --lines 100`.
- **Clean up:** `herdr pane close <pane_id>` / `herdr tab close <tab_id>` / `herdr workspace close <id>`.

`agent start` needs the pane at a shell prompt and BLOCKS until Herdr detects
the agent (up to ~30s+); pass a generous `--timeout`.

## Procedure

1. Know the model before choosing a command. A **pane** is a terminal location; an **agent** is the recognized process currently inside it. `agent start` needs an EXISTING shell pane at its prompt — it never creates or splits layout. Creating a workspace also creates its first tab and root pane.
2. Create layout and capture IDs from the JSON response — never predict IDs. `herdr workspace create --cwd ~/p --label api --no-focus` → `.result.workspace.workspace_id`, `.result.tab.tab_id`, `.result.root_pane.pane_id`. `herdr tab create` → `.result.tab.tab_id` + `.result.root_pane.pane_id`. `herdr pane split <id> --direction right|down [--ratio F] --no-focus` → `.result.pane.pane_id`. After `herdr pane move`, the ID CHANGES: use `.result.move_result.pane.pane_id` (old value at `.result.move_result.previous_pane_id`).
3. Pick the control surface by intent. Raw terminal: `pane run <id> <cmd>` (submits text+Enter atomically, honors bracketed paste — prefer over send-text+send-keys), `pane send-text` (no Enter), `pane send-keys <key>...`, `pane wait-output <id> --regex RE [--lines N] [--timeout MS]`. Recognized agent: `agent start <name> --kind KIND --pane ID [--timeout MS] [-- args...]`, `agent prompt <target> <text> [--wait] [--until STATUS] [--timeout MS]`, `agent send-keys`, `agent wait`, `agent read`, `agent explain`, `agent focus`, `agent rename`.
4. Read output with the right source. `pane read <id> --source visible|recent|recent-unwrapped|detection [--lines N] [--ansi]`. Recent sources default to 80 rows; `--lines N` takes the last N rendered rows. `visible`/`detection` return the full snapshot unless `--lines` is given. ANSI is stripped unless `--format ansi`/`--ansi`; `detection` is always plain text. Prefer `recent-unwrapped` for reading prose/transcripts.
5. Read alternate-screen agent history deliberately. Full-screen agents (Claude Code, OpenCode, pi) keep transcript history in the terminal's ALTERNATE SCREEN, not Herdr scrollback — so `scroll.max_offset_from_bottom` is often ~0 and scrolling the pane reveals nothing. For an **idle, recognized** agent at the bottom of its transcript, `recent`/`recent-unwrapped` with `--lines` greater than the visible screen automatically drive the agent's own mouse-scroll to harvest pages. While the agent is working/blocked/unknown this returns `agent_not_idle` — wait for idle and retry, or fall back to `--source visible`.
6. Wait on the right signal. `agent wait <target> [--until idle|done|blocked|unknown]... [--timeout MS]` defaults to idle/done/blocked and returns immediately if already matching. `agent prompt --wait` requires an observed state change within 5s or returns `agent_prompt_stalled`; `--until` requires `--wait`. Waits have NO default timeout — always pass `--timeout`. `pane wait-output` does not understand lifecycle and matches text already on screen.
7. Understand the lifecycle words: `idle` = ready for input AND its tab was seen in the focused UI; `done` = same idle state after background work, until focused; `blocked` = an approval/question UI was recognized; `unknown` = agent present but unclassifiable (NOT proof of success). CLI reads do not mark a tab seen.
8. For programmatic use, speak the socket API directly at `~/.config/herdr/herdr.sock`: newline-delimited JSON, one request per connection, `{id, method, params}` in and `{id, result|error}` out; the server closes after answering. Get the full contract with `herdr api schema --json` (method names live as `const` values in the request schema).
9. Verify state with `herdr pane list`/`pane get` (includes `scroll` and `foreground_cwd`), `herdr agent list`, `herdr workspace list`, `herdr tab list`. Clean up test artifacts with `herdr pane close`, `herdr tab close`, `herdr workspace close` (state only) or `herdr worktree remove` (deletes the checkout, needs `--force` when dirty).

## Pitfalls

- Socket result payloads are nested under a per-method key, and the key is NOT uniform: `pane.read` → `.result.read.text`, `pane.split` → `.result.pane.pane_id`, `pane.zoom` → `.result.zoom`, `workspace.create` → `.result.workspace` / `.result.root_pane`. Reading `.result.text` for pane.read silently yields undefined — an empty string, not an error.
- `pane send-keys` has NO PageUp/PageDown. `page_up`, `pgup`, `PageUp`, `prior` all return `invalid_key`. Do not try to scroll a TUI by forwarding page keys; use `pane read --source recent[-unwrapped] --lines N` instead.
- Agent TUIs in the alternate screen ignore forwarded scroll input: SGR mouse wheel sequences (`ESC[<64;x;yM`) and `ESC[5~` both do nothing when sent via `pane send-text`. Reading is the only reliable way to get their history.
- `pane zoom` succeeds but no-ops on a single-pane tab, returning `changed:false, reason:"single_pane"`. Check `.result.zoom.changed` rather than assuming success from the absence of an error.
- `agent start` requires the pane to be at an interactive shell prompt with no foreground command. Return the pane to its prompt first or it fails.
- Wait commands can block forever — they have no default timeout. Always pass `--timeout MS`.
- Names must match `[a-z][a-z0-9_-]{0,31}` and are aliases, not renames: the alias clears when the agent exits, is released, or is replaced.
- Layout creation does NOT steal focus by default (`--no-focus` is the default for workspace/tab create and pane split). Pass `--focus` when you actually want to switch.

## Verify

1. `herdr status` and `herdr api schema --json | head` confirm the server is up and the protocol version.
2. After any create/split, echo the captured ID and confirm it appears in `herdr pane list` before using it.
3. After `agent start`/`agent prompt --wait`, check `.result.agent` and confirm state with `herdr agent get <target>`.
4. For a read that should include history, confirm the returned line count exceeds the visible viewport (compare against `--source visible`); if it does not, the agent was probably not idle.
