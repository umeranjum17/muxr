# Which agent CLIs report status inside Herdr Core

Measurement for the Herdr Core switch (ticket jg-kile-s2, call 3 of the plan): does each
supported agent CLI report status itself? Herdr Core never guesses status from the screen; it
only takes what the program sends over OSC 7501, so a silent CLI has no status. No user sees
this and no product setting changes.

## Sub-features

- **Pin**: `HERDR_CORE_PIN` in `perf/lib/herdrCoreLab.mjs` is Herdr Core 0.1.20 with its Linux
  SHA-256s, checked against the release manifest on every use.
- **Journey `herdr-core-status-table`** (`herdrCoreStatusTable.mjs`):
  - Starts every installed CLI of `claude codex pi opencode gemini grok` in a private lab core,
    with a scratch HOME and the harness attach answering terminal queries, in this checkout.
  - Gives each one prompt and records the status events the program sends.
  - A CLI not on PATH reads `not measured: not installed`; one that asks a question first, draws
    nothing, or never answers reads `not measured: <why>`. It never answers a dialog (except Skip
    on an update notice) and never edits a login.
  - Measures twice in two fresh cores; verdicts must be identical, and the table keeps the states both runs saw.

## How to get to it

`done-done verify herdr-core-status-table --outcome "<claim>"` from the repo root. It needs no
build and no phone. It sends one short prompt to each installed CLI and does not control whether a model answers.

## Table (2026-11-14, Herdr Core 0.1.20, Linux)

Every CLI runs with a scratch HOME inside the lab core's dir. The harness attach
(`perf/lib/herdrCoreAttach.mjs`, lab-only, shares no code with the product terminal bridge)
answers the terminal queries a TUI sends before it draws. The "seen by" column says whether it
attached: `harness attach`, or `none: attach failed (<error text>)`.

| agent | version | measured | seen by | status in Herdr Core 0.1.20 |
|---|---|---|---|---|
| claude | 2.1.325 (Claude Code) | 2026-11-14 | harness attach | not measured: no answer to the prompt was seen (0 queries answered through the attach) |
| codex | codex-cli 0.159.2 | 2026-11-14 | none: attach failed | not measured: it exited at start |
| pi | 1.0.0 | 2026-11-14 | harness attach | not measured: it asks before a prompt ("trust them") |
| opencode | 1.18.25 | 2026-11-14 | harness attach | not measured: it asks before a prompt ("trust them") |
| gemini | 0.56.0 | 2026-11-14 | harness attach | not measured: it asks before a prompt ("trust them") |
| grok | grok 1.0.0 (3cd0d0cbce) | 2026-11-14 | harness attach | not measured: it asks before a prompt ("trust them") |

No status was measured in this run: no row reports a status event. A row that did not answer
names only what was seen on screen (for example the question it asked, quoted), never a guessed cause. The gate "a CLI drew its screen through the attach"
passes when an installed CLI was seen by the harness attach and drew or reported through the harness attach.
