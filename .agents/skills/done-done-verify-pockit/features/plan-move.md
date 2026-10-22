# Move a conversation to another account

A running Claude conversation moves to the person's other Claude account from
its Pane actions › Move to another account: the phone says `Moved to <account>`,
the same conversation carries on in the same tab on the new account's sign-in,
and the host records the new account for it. The kit owns the move
(`@byokit/herdr` `move`, called from `movePlanAccount` in
`apps/host/src/agent/infrastructure/herdrSessionSource.ts`); the sheet is
`MoveSheet` in `apps/mobile/sources/plans/presentation/MoveAccount.tsx`.

## Sub-features

- `plan-move-there` A to B: the notice names B, the pane runs on B's sign-in
  and shows the conversation so far.
- `plan-move-back` B to A: the same, back again.

## How to get to it (user POV)

- Open an agent running on one of two signed-in Claude accounts, tap Pane
  actions, Move to another account, then Move to <account>.

## Driving it on a lab Herdr

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
  from the lab link with no phone.
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
