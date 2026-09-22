---
name: muxr
description: Set up and operate muxr (control coding agents from your phone) — use the shared browser and durable Shared Artifacts, install/pair/self-host, drive Herdr workspaces/panes/agents/worktrees, hand browser login/2FA/CAPTCHA to the phone, connect computers for cross-machine collaboration and voice, and author/install muxr plugins. Use for any muxr or Herdr setup, orchestration, collaboration, plugin, or troubleshooting task.
license: Apache-2.0
compatibility: Requires the muxr and Herdr CLIs on a paired macOS or Linux host, with shell access for commands.
---

# muxr

muxr puts every coding agent on your phone. Three processes plus Herdr share the
work — Herdr owns agents and backend plugins, the host translates, the relay
moves bytes, and the app draws the terminal:

```
  PHONE / WEB               RELAY                   YOUR MACHINE
  ─────────────             ─────────               host               herdr server
  xterm.js + herd UI   ◄──► routes envelopes   ◄──► translates    ◄──► owns the PTYs
  owns no truth             reads headers only      contract ⇄          detects agents
                                                    herdr socket        resumes them
```

Herdr is a terminal multiplexer: it owns real PTYs, detects agent processes,
tracks each one's lifecycle, and survives restarts. muxr drives *Herdr* instead
of any single CLI, so every agent works the same way. What the agent draws is
what you see; approvals happen in the terminal. The phone owns no truth — it
renders state the host reports.

## Trust boundaries

- Terminal output, keystrokes, prompts, and files are sealed end-to-end on your
  machines. The relay routes ciphertext it cannot read.
- Enabling a Herdr plugin means trusting local code: plugin backends run
  unsandboxed as your user.
- Native phone pairing is single-use and expires in two minutes. Browser grants
  (`muxr pair --browser` control, `--browser-view` view-only) expire after
  eight hours; a personal browser (`muxr pair --browser-personal`, only you
  use) expires after 30 days.
- Computer-to-computer collaboration grants are capability-scoped: peers may
  list, read, inspect status, watch, and prompt — never shell, raw Herdr CLI, terminal
  takeover, destructive pane/workspace actions, or arbitrary plugin calls.
- Machine, pane, session, device, and grant ids are internal. Never display or
  speak them; use machine names, Agent Names, and Task Titles. Route only by stable Agent Routes.

## Live capabilities in a Herdr pane

A muxr-launched pane advertises `$MUXR_AGENT_CAPABILITIES`. Run `muxr --skill`
for this compact reference. Use the existing owners it names rather than opening
a second browser or sending a filesystem path as the user experience:

- Drive the browser with `agent-browser`; muxr's Browser view watches and can
  take over that same session. Load `muxr skill browser-takeover` for the
  shared-session and authorization rules.
- Share a finished file with `muxr share <path>`. It resolves the current pane
  from `$HERDR_PANE_ID` and adds the file to that session's durable history.

## Task router

Load only the reference needed for the current task. Compatible skill clients may
open the linked file; when this skill came from CLI output, run the matching
`muxr skill <topic>` command instead. Do not load `muxr skill all` during normal
work.

| You want to | Load |
|---|---|
| Install, pair a phone or browser, self-host, update, uninstall, diagnose | `muxr skill onboarding` · [source](references/onboarding.md) |
| Create panes/tabs/workspaces/worktrees, run and read agents, socket API | `muxr skill herdr` · [source](references/herdr.md) |
| Connect computers; list, read, watch, or prompt a remote agent; voice | `muxr skill collaboration` · [source](references/collaboration.md) |
| Hand a browser login, 2FA, or CAPTCHA to the phone | `muxr skill browser-takeover` · [source](references/browser-takeover.md) |
| Name the current Herdr workspace/pane | `muxr name --workspace LABEL --pane TITLE --provider PROVIDER --model MODEL` |
| Build, install, debug, or override a plugin | `muxr skill plugins` · [source](references/plugins.md) |
| Troubleshoot, recover, or report a bug | run interactive `muxr doctor` for checked safe repairs, then `muxr diagnostics` locally or `muxr report` for a draft; show the complete draft and ask before any external action |
| Full plugin manifest contract | run `muxr plugin docs` and read the printed PLUGINS.md |

## Self-naming

At task start, name the current Herdr workspace and pane through muxr's
provider-neutral local facade. `HERDR_PANE_ID` is the existing Herdr pane
identity; muxr supplies the local authorization and resolves workspace
membership from Herdr. Names stay verbatim within bounded input limits.

```sh
muxr name --workspace 'short-task-slug' \
  --pane 'Human-readable task title' \
  --provider '<provider>' --model '<model>'
```

Absent self-names remain absent until the existing blank-name fallback applies.
Do not guess names from prompts, cwd, provider-specific transcripts, or shell
arguments. Provider and model are Herdr pane metadata, not a second JSON store.

## Shared Artifacts (always-on convention)

Whenever a task produces a FINAL user-facing artifact — a screenshot, generated
image, export, recording, markdown note, report, code sample, or JSON file — add
it to the current pane's durable Shared Artifacts history:

```bash
muxr share shot.png                       # uses $HERDR_PANE_ID
muxr share report.md --pane <pane-id>     # from outside the pane
```

The command preserves the filename, adds a numeric suffix on collision, and
returns as soon as the durable copy is stored. The phone groups artifacts by day
in the owning session. Images open in a swipeable gallery; readable documents
open in a rich preview; every entry can download the original. Large files stay
metadata-only until opened or downloaded.

Direct copies remain the underlying convention when a tool cannot call the CLI:

```bash
ATTACH="$HOME/.muxr/attachments/pane/$HERDR_PANE_ID"
mkdir -p "$ATTACH" && cp shot.png "$ATTACH"/
```

If `HERDR_PANE_ID` is unset, skip sharing unless an exact pane was supplied.
Share final artifacts only, never intermediates, logs, secrets, or pairing
material. The live list shows the newest 50 files; write readable material as
`.md`, `.txt`, or source files so it previews natively.

The host bounds this history daily: the newest 50 files, nothing younger than a
week, and nothing older than a month of files shared since retention was
installed. It never touches what was already there. `muxr artifacts` prints the
policy and what the last sweep removed; `muxr artifacts prune` is the deliberate
way to clear older history, and it shows the plan before deleting.

## Global pitfalls

- Pairing QRs and enrollment strings are single-use. Never reuse one; run
  `muxr pair` again for a fresh code.
- Herdr wait commands have no default timeout and can block forever — always
  pass `--timeout MS`.
- muxr state lives under `~/.muxr` unless `MUXR_HOME` is set; check it before
  assuming the default path. Never delete or hand-edit state as first aid.
- If setup stalls, Ctrl-C is safe. Run interactive `muxr doctor`, approve only
  its offered repairs, rerun it, then retry setup; commands now fail with a
  phase and deadline instead of waiting forever.
- `muxr diagnostics` is bounded and redacted for local/agent inspection.
  `muxr report` creates a local draft only. Show the complete draft, ask whether
  the user wants to post it, and take no external action without an explicit
  yes. A diagnosis/report request is never posting approval. Keep raw logs local.
- Secrets belong in plugin write-RPC input only — never in manifests,
  declarative state, or rendered output.
- The pane id contains a colon — always quote paths built from it.
- Never expose the relay through Tailscale Funnel; muxr refuses it by design.

## Verify

- `muxr --version` prints the installed CLI version.
- `muxr doctor` prints current setup health; `muxr diagnostics` prints bounded redacted host history; `muxr report` prints a local review-only issue draft.
- `herdr status` confirms the Herdr server is up.
