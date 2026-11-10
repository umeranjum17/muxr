# Which agent CLIs report status inside Herdr Core

Measurement for the Herdr Core switch (ticket jg-kile-s2, call 3 of the plan): does each
supported agent CLI report status itself? Herdr Core never guesses status from the screen; it
only takes what the program sends over OSC 7501, so a silent CLI has no status. No user sees
this and no product setting changes.

## Sub-features

- **Pin**: `HERDR_CORE_PIN` in `perf/lib/herdrCoreLab.mjs` is Herdr Core 0.1.19 with its Linux
  SHA-256s, checked against the release manifest on every use.
- **Journey `herdr-core-status-table`** (`herdrCoreStatusTable.mjs`):
  - Starts every installed CLI of `claude codex pi opencode gemini grok` in a private lab core,
    as installed (the person's own login, normal HOME), in this checkout.
  - Gives each one prompt and records the status events the program sends.
  - A CLI not on PATH reads `not measured: not installed`; one that asks a question first, draws
    nothing, or never answers reads `not measured: <why>`. It never answers a dialog (except Skip
    on an update notice) and never edits a login.
  - Measures twice in two fresh cores; verdicts must be identical, and the table keeps the states both runs saw.

## How to get to it

`done-done verify herdr-core-status-table --outcome "<claim>"` from the repo root. It needs no
build and no phone. It makes one tiny real model call per signed-in CLI.

## Table (2026-11-10, Herdr Core 0.1.19, Linux)

| agent | version | status in Herdr Core |
|---|---|---|
| claude | 2.1.322 | reports status unprompted (`idle`) and on the prompt (`blocked(auth)`: the account could not run turns, so `done` is not measured) |
| codex | 0.159.2 | not measured: an update notice asks first |
| pi | 1.0.0 | not measured: drew nothing in the lab core |
| opencode | 1.18.25 | not measured: drew nothing in the lab core |
| gemini | 0.56.0 | not measured: drew nothing in the lab core |
| grok | 1.0.0 | not measured: drew nothing in the lab core |

Pi, OpenCode, Gemini and Grok draw nothing until a viewer answers their terminal queries; the
lab has none. Measuring them needs a viewer-shaped client, a follow-up slice. Until then call 3
stands unanswered for those four.
