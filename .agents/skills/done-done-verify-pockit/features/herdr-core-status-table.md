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
build and no phone. It makes no model call: the scratch HOME has no login.

## Table (2026-11-14, Herdr Core 0.1.20, Linux)

Every CLI runs with a scratch HOME inside the lab core's dir, so none has a login. The harness
attach (`perf/lib/herdrCoreAttach.mjs`, lab-only, shares no code with the product terminal
bridge) answers the terminal queries a TUI sends before it draws. Each row is seen by it.

| agent | version | seen by | status in Herdr Core |
|---|---|---|---|
| claude | 2.1.325 | harness attach | not measured: no answer to the prompt was seen (no login) |
| codex | 0.159.2 | harness attach | not measured: it exited at start (no login) |
| pi | 1.0.0 | harness attach | not measured: no answer to the prompt was seen (no login) |
| opencode | 1.18.25 | harness attach | not measured: no answer to the prompt was seen (no login) |
| gemini | 0.56.0 | harness attach | not measured: no answer to the prompt was seen (no login) |
| grok | 1.0.0 | harness attach | not measured: no answer to the prompt was seen (no login) |

A scratch HOME has no login, so no CLI reaches a model turn and `done` is not measured for any
of them. A logged-in measurement needs a decision about lending a scratch HOME a login.
