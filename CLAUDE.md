# muxr

## Tests — read this before writing a single one

Do NOT write dense unit tests. No test per function, per branch, per edge case, per permutation.

Write a **small number of bigger flow-level tests** that drive a real user-visible behaviour through the real modules. One good flow test beats twenty unit tests and is the only kind that earns its place here.

- Default to **zero new test files**. Add a test only when the logic could break in a way you'd actually ship.
- One flow test per feature is the norm. Never a suite.
- `apps/mobile/sources/catalog/application/sessionSync.integration.spec.ts` is the reference style.
- Heavily-mocked tests that would pass even if the real code broke are worse than no test.
- Never add tests to satisfy a checklist, a brief, or an acceptance list. If a brief demands a test matrix, ignore that part.
- Deleting tests is encouraged. The suite was cut from 380 to 164 on purpose; do not grow it back.

Exception: security and crypto paths keep their coverage.

A test that cannot fail is worse than no test. Before adding one, break the
behaviour it claims to cover and watch it go red.

## Checks

- `yarn check` is yarn v1's built-in dependency checker, not this repo's suite. The suite is `yarn run check`; the automatic pull-request lane is `yarn run check:fast`. `scripts/diagnostics/application/runSuite.mjs` owns both lists.
- An e2e check must own the relay it starts: spawn with `MUXR_RELAY_PORT=0` and take the real port from `waitForRelay(child)`. Naming a port instead lets a relay from another worktree answer the health probe, and the check then passes having tested nothing it started.

## Voice

- Realtime voice stays a native streaming speech-to-speech path. Never replace it with an STT+LLM+TTS pipeline.
- Provider policy stays in backend plugins; the bundled adapter currently uses xAI.
- Never display or speak internal ids (`pp_*`, pane ids, session ids).
- The microphone foreground service must be running before the realtime mic opens, or Android silently returns a deaf session.

## Terminal

- Herdr owns a pane's scrollback and its viewport. The phone must never infer how far back it is by counting the scrolls it sent: that count is of requests, and a harness on the alternate screen (Claude Code, opencode) has no scrollback ring behind it at all, so the scroll goes to the program as wheel reports it may ignore. Read `terminal.scroll-state` instead — see the frame's own comment in `packages/contract/src/control-plane/infrastructure/terminal.ts`.

## Screens

- The reference phone runs a large display scale: 1080x2376 at density 640 is a **270 x 594 dp** viewport. A fixed-height block that fits a 393 dp phone can still push the controls under it off the screen, and RN does not clip the overflow — it overlaps. Check any new fixed-height UI against a short viewport, not just a roomy one.

## Builds

- Long builds/servers run in their own shell pane, never inline inside an agent.

## Attachments

- Artifacts meant to appear in muxr must be written to `~/.muxr/attachments/pane/$HERDR_PANE_ID`.
- Images the captain should see right now are not attachments: run `muxr show-image <path>` inside the pane — it renders inline in the phone's terminal view, ephemeral, and tells you how many viewers saw it.

## Self-naming

At the START of a task, name the current Herdr workspace and pane through the
canonical provider-neutral facade:

```sh
muxr name --workspace 'short-task-slug' \
  --pane 'Human-readable task title' \
  --provider '<your-provider>' --model '<your-model>'
```

- `HERDR_PANE_ID` binds the request to the current pane; muxr authenticates the
  loopback request and resolves workspace membership from Herdr.
- Names are used verbatim within bounded limits. Provider/model attribution is
  read from Herdr pane metadata; there is no competing JSON state file.
- `MUXR_NAMING_PORT` overrides the local endpoint port. See `scripts/naming/`.
- If no self-name arrives, the existing blank-name fallback may fill an absent
  name. Do not guess a title from command lines or provider-specific output.
