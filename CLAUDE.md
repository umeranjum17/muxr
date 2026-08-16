# muxr

## Tests — read this before writing a single one

Do NOT write dense unit tests. No test per function, per branch, per edge case, per permutation.

Write a **small number of bigger flow-level tests** that drive a real user-visible behaviour through the real modules. One good flow test beats twenty unit tests and is the only kind that earns its place here.

- Default to **zero new test files**. Add a test only when the logic could break in a way you'd actually ship.
- One flow test per feature is the norm. Never a suite.
- `apps/mobile/sources/sync/sessionSync.integration.spec.ts` is the reference style.
- Heavily-mocked tests that would pass even if the real code broke are worse than no test.
- Never add tests to satisfy a checklist, a brief, or an acceptance list. If a brief demands a test matrix, ignore that part.
- Deleting tests is encouraged. The suite was cut from 380 to 164 on purpose; do not grow it back.

Exception: security and crypto paths keep their coverage.

## Voice

- Realtime voice stays a native streaming speech-to-speech path. Never replace it with an STT+LLM+TTS pipeline.
- Provider policy stays in backend plugins; the bundled adapter currently uses xAI.
- Never display or speak internal ids (`pp_*`, pane ids, session ids).
- The microphone foreground service must be running before the realtime mic opens, or Android silently returns a deaf session.

## Builds

- Android builds are **local only** (`eas build --local`). Never use cloud EAS credits.
- Long builds/servers run in their own shell pane, never inline inside an agent.

## Attachments

- Artifacts meant to appear in muxr must be written to `~/.muxr/attachments/pane/$HERDR_PANE_ID`.
