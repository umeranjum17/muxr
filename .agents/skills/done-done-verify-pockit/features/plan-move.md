# Move a conversation to another account

A running Claude conversation moves to the person's other Claude account from
its Pane actions › Move to another account: the sheet closes and the header
chip names the new account (the `Moved to <account>` notice shows only on the
Accounts screen), the same conversation carries on in the same tab on the new account's sign-in,
and the host records the new account for it. The kit owns the move
(`@byokit/herdr` `move`, called from `movePlanAccount` in
`apps/host/src/agent/infrastructure/herdrSessionSource.ts`); the sheet is
`MoveSheet` in `apps/mobile/sources/plans/presentation/MoveAccount.tsx`.

## Sub-features

- `plan-move-there` A to B: the chip names B, the pane runs on B's sign-in
  and shows the conversation so far.
- `plan-move-back` B to A: the same, back again.
- `plan-move-busy` Phone requests send `waitForIdleMs: 120000` within their
  existing 240-second request; expiry says it is still working and to finish
  the step before trying again. No replacement is staged until idle.
- `plan-move-warning` A committed replacement stays a successful move when
  readiness/account refresh fails, with a separate reconnect warning.
- `plan-move-rollback` A real shell that fails environment verification loses
  only the staged pane; the original and complete pane inventory survive.

## How to get to it (user POV)

- Open an agent running on one of two signed-in Claude accounts, tap Pane
  actions, Move to another account, then Move to <account>.

## Driving it on a lab Herdr

- Set `HERDR_LAB_SESSION` with `"$HERDR_LAB_HELPER" name <task>` and install
  the parent shell's guarded EXIT cleanup before the drive provisions it.
  Every stand-in report also goes through that helper, never ambient Herdr.
- `yarn build`, a release APK from `node perf/buildPrApk.mjs <out>`, and a
  Herdr lab helper in `HERDR_LAB_HELPER` (see `linkHerdrLab.mjs`); take the
  emulator lock as in `../SKILL.md`.
- `node .agents/skills/done-done-verify-pockit/features/planMoveLab.mjs <apk> <evidence> <labRoot>`
  (a fresh, short `<labRoot>` per run, e.g. `mktemp -d ~/.cache/fms/mxmv.XXXX`:
  the lab sockets live under it, and a reused root keeps every earlier run's
  accounts, so the sheet lists Account A and B many times over). It adds two stand-in
  Claude accounts through the accounts kit (`Account A`, `Account B`), starts a
  stand-in Claude on A, pairs the APK, records the screen and moves A to B and
  B to A from the phone. Pass `-` for `<apk>` to move through `plans.move`
  from the lab link with no phone. Both modes also run a real-shell negative
  control: the production move is asked to verify HOME absent while the shell
  has HOME. It must return `plan-move-env-mismatch`, close the staged pane and
  preserve the original pane inventory (`verification-rollback.txt`).
- Pass: `journey.log` ends `PASS`; each `*-on-account-*.png` shows the pane
  saying which account it runs on (`umer.a@` / `umer.b@example.com`) with
  `Resumed this conversation:` and the earlier turns under it;
  `move-a-b-a.mp4` shows both moves.

- Browser (PWA) route, no emulator: build the export with the lab flag
  (`EXPO_PUBLIC_MUXR_LAB_PAIR=1 yarn build && EXPO_PUBLIC_MUXR_LAB_PAIR=1 yarn web:export`),
  run `MUXR_LAB_MACHINE_NAME="Lab computer" node .../planMoveLab.mjs web <evidence> <labRoot>`
  (it writes `<labRoot>/browser-link.txt` and stays up until `<labRoot>/stop` exists),
  serve the export (`lab-browser-pairing.md`), pair with `window.__MUXR_LAB_PAIR__`,
  open the agent at 390 px: the header chip reads `Account A`; Pane actions › Move to
  another account › Move to Account B; the chip then reads `Account B`.
- PWA completed-move warning: only in this synthetic lab, `chmod 400
  <labRoot>/lab/muxr/plans/agent-panes-v1.json` immediately before the next
  move. The sheet must close and say **Moved to Account A/B**, separately show
  the reconnect warning, and the real pane must run on that account. Capture
  the dialog, then restore `chmod 600` even on failure. Run the PWA Visual
  check at 270/393 dp, font 1.0/2.0, both themes, plus desktop widths. Never
  make a real account store read-only. `browser-session.json` names this lab's
  session for the driver; stopping the web lab also runs real verification
  rollback before teardown.

## Busy and post-commit proof by layer

Run `npx vitest run apps/host/src/agent/infrastructure/herdrSessionSource.move.test.ts
apps/host/src/requests/application/createRequestDispatcher.test.ts`, then
`npx vitest run apps/mobile/sources/plans/plansLaunch.integration.spec.ts --config apps/mobile/vitest.config.ts`
from the repo root for the phone boundary. The existing flow drives the real
source and pinned kit over a fake Herdr socket: working → bounded wait →
explicit timeout with no split; working → idle → verified replacement; failed
replacement → original retained; successful move → failed snapshot → success
with warning. The dispatcher proves the phone budget reaches the source,
rejects oversized waits and keeps post-commit account refresh errors separate.

Use fake Herdr for the **busy path only**: the lab stand-in's reported working
state is overridden to idle by real Herdr, so it cannot honestly prove this
admission path. Do not label a real idle lab move as busy-path evidence.
Native/PWA captures prove the real idle-move sheet and account transition,
not busy-state admission. The busy confirmation and timeout are covered by
integration, not by an app pointed at the live default session. Post-commit
refresh warnings are likewise checked through the source, dispatcher and phone
API flows; use the explicit PWA read-only-file probe above for real warning-dialog
captures, never label ordinary idle-move screenshots as warning-dialog proof.

## Gotchas

- The terminal draws natively, so its text is never in a UI dump: the phone
  side waits on the header's account chip (`text="Account A"`), and the pane's
  own screen is read through Herdr.
- Provision the lab Herdr only through the lab script: it puts the stand-in
  `claude` first on `PATH` before provisioning, and a session provisioned from
  an ordinary shell starts the installed Claude in its panes instead.
- Real Herdr never reports a pane's env in `pane.get`; a fixture that does hid
  the env check failing on every move (`@byokit/herdr` 0.16.1). The host move
  test's fake Herdr answers like Herdr 0.9.1.
- Herdr settles a newly started agent once (idle, unknown, idle) a few seconds
  after launch; a move inside that window is refused as changed, so the lab
  waits for the agent to hold still.
- The stand-in reports its conversation with `--source herdr:claude`, as
  Claude's Herdr hook does; any other source leaves `agent_session` empty and
  the move menu says to wait for the first reply.
- The guarded Herdr helper pins `CLAUDE_CONFIG_DIR`, so `plans.add`'s
  per-account hook install cannot run in a lab; the lab adds accounts through
  the kit directly.
