---
name: muxr
description: Set up and operate muxr (control coding agents from your phone) — install/pair/self-host, drive Herdr workspaces/panes/agents/worktrees, share pane attachments, hand browser login/2FA/CAPTCHA to the phone, connect computers for cross-machine collaboration and voice, and author/install muxr plugins. Use for any muxr or Herdr setup, orchestration, collaboration, plugin, or troubleshooting task.
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
  eight hours.
- Computer-to-computer collaboration grants are capability-scoped: peers may
  list, read, inspect status, watch, and prompt — never shell, raw Herdr CLI, terminal
  takeover, destructive pane/workspace actions, or arbitrary plugin calls.
- Machine, pane, session, device, and grant ids are internal. Never display or
  speak them; use machine names, Human Names, and Task Titles. Route only by stable Agent Routes.

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
| Build, install, debug, or override a plugin | `muxr skill plugins` · [source](references/plugins.md) |
| Troubleshoot | run `muxr doctor`, then `muxr diagnostics`; load the relevant topic's Pitfalls and Verify sections |
| Full plugin manifest contract | run `muxr plugin docs` and read the printed PLUGINS.md |

## Pane attachments (always-on convention)

Whenever a task produces a FINAL user-facing artifact file — screenshots,
generated images, exports, recordings, and documents (markdown notes, emails,
reports, code, JSON) — copy it into the current pane's watched attachments
directory so it appears as a pill on the phone:

1. Compute the dir: `ATTACH="$HOME/.muxr/attachments/pane/$HERDR_PANE_ID"`
   (`HERDR_PANE_ID` is injected into every Herdr pane; the id contains a colon —
   quote the path).
2. `mkdir -p "$ATTACH"` and copy the final artifact there: `cp shot.png "$ATTACH"/`
   — one command, then continue the task.
3. The host watches the dir, compresses raster images (max edge 1568px, webp
   q80), inlines text/docs whole (≤256KB), videos (≤32MB), and PDFs (≤8MB), and
   the phone shows them on that pane's session within ~1s. Images open a
   swipeable carousel; text/docs open a readable preview; videos play in the
   browser player; PDFs render page-by-page. Every row has a download button —
   oversized files are fetched from the host on demand.

Rules: if `HERDR_PANE_ID` is unset you are not in a Herdr pane — skip silently.
Do not dump intermediates or logs; the dir is a user-facing surface with a
50-file cap. No manual downscaling — the host compresses images automatically;
save at full resolution. Write documents directly as `.md`/`.txt`/code files so
they preview natively.

## Global pitfalls

- Pairing QRs and enrollment strings are single-use. Never reuse one; run
  `muxr pair` again for a fresh code.
- Herdr wait commands have no default timeout and can block forever — always
  pass `--timeout MS`.
- muxr state lives under `~/.muxr` unless `MUXR_HOME` is set; check it before
  assuming the default path.
- Secrets belong in plugin write-RPC input only — never in manifests,
  declarative state, or rendered output.
- The pane id contains a colon (`w2A:p4`) — always quote paths built from it.
- Never expose the relay through Tailscale Funnel; muxr refuses it by design.

## Verify

- `muxr --version` prints the installed CLI version.
- `muxr doctor` prints current setup health; `muxr diagnostics` prints bounded redacted host history.
- `herdr status` confirms the Herdr server is up.
