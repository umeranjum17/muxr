# See pinned spaces on the phone's Spaces list

A space the user pins from its long-press menu leads the phone's Spaces list
under a quiet `Pinned` label, its card otherwise identical to an unpinned one;
every other space follows under `Spaces`.

## Sub-features

- `spaces-pin` long-press a space card -> `Pin to top` moves it under `Pinned`.
- `spaces-pinned-card` a pinned card shows chevron, state dot, name and agent
  count, and no pin glyph after the name.
- `spaces-pin-scope` two paired computers may both have `w1`; their pins never mix.
- `spaces-pin-upgrade` old phone-local pins survive the machine-scoped migration.

## How to get to it (user POV)

- Home -> Spaces list -> long-press a space card -> `Pin to top`.

## Driving it with the private stack

Preconditions:

- `yarn build`, and a release APK from `node perf/buildPrApk.mjs <out>`
  installed on an owned emulator `SERIAL`. This drives the phone, so it uses
  `perf/lib/fakeStack.mjs` (real relay, host and E2EE pairing over a fake
  Herdr) instead of `../SKILL.md` Launch: the host's `--fake` source has no spaces.

- **Seed and pair.** From the repo root, in its own shell:
  `SERIAL=<serial> node --input-type=module -e "$(< .agents/skills/verify-muxr/features/spacesLab.mjs)"`.
  Keep stdin attached: the recipe reads computer numbers and stops at EOF.
  It adds `api-server`, `infra` and `mobile-app` with `pi` agents named
  `umer-*`, opens the app's `muxr://pair` link and prints `lab computer 1 ready`; tap
  `Pair`, then `Don't allow` on the notification prompt.
- **Pin.** Long-press `api-server` -> `Pin to top`, then `infra`. Both lead
  under `Pinned`; `mobile-app` stays under `Spaces`.
- **Capture** with `adb -s $SERIAL exec-out screencap -p`, in dark and light
  (`adb shell cmd uimode night yes|no`, then force-stop and relaunch the app)
  and at tablet width (`adb shell wm size 1600x2560 && adb shell wm density 320`;
  undo with `wm size reset && wm density reset`). `adb shell screenrecord`
  records the pin itself.
- **Two-computer scope and upgrade.** Provision two non-default Herdr sessions
  with the guarded lab helper and its EXIT teardown. Through that helper create
  `api-server` on A and `backend` on B as their first workspace (both `w1`).
  Use a helper-backed `HERDR_BIN` wrapper for each session; never the default.
  Write a JSON array of live-stack configs (`sourceRoot`, private `authHome`,
  `socketPath`, `clientSocketPath`, helper-backed `binPath`, `machineName`),
  naming the computers `Umer desk` and `Umer laptop`. Run the **Seed and pair**
  command with `SPACES_LAB_HOSTS=<config-file>` also set; live mode uses those
  sessions without seeding fake workspaces.
  Enter `2` to pair B, then use the header's machine picker to return to A.
  On a baseline native APK, pin A's `api-server`: B's `backend` incorrectly
  appears pinned. Leave A active and upgrade in place with the same signer.
  On the candidate, A's legacy pin stays; B is unpinned. Pin B, return to A,
  unpin A, return to B: only B remains pinned. Force-stop/relaunch and repeat
  the reads. Capture each action and machine-labelled result, plus the motion.
  Legacy pins have no machine identity. Migration assigns a pin only when it
  appears in a tree served by that computer; it never guesses from the active
  computer or probes other computers. Unmatched ids remain in the legacy store
  until a later confirmed tree matches them. Switched-connection results are
  rejected. Explicit pin edits supersede legacy state, and migration completes
  before publishing a tree. Empty legacy arrays are cleared locally without a
  probe or alert. The existing `sessionSync.integration.spec.ts` Spaces journey
  proves delayed matching, stale-result rejection, edit preservation and scope.
- Stop the lab with Ctrl-C (it stops only what it started), then tear down both
  named sessions with the helper. Remove the task-owned emulator and scratch.

## Gotchas

- The app reads the system theme at launch; a live `uimode` change shows the
  old theme until it is relaunched, and each launch re-asks for notifications.
- Pin scope is documented in [README.md](../../../../README.md#every-agent-every-machine).
  A reinstall or `pm clear` drops pins; never clear data between baseline and upgrade.
- `spaces-pins-v1` is removed only when empty. Matched pins are written to
  `spaces-pins-v2` before removing them from v1; unmatched pins remain in v1.
- A header reading `offline` mid-run means the `adb reverse` tunnel to the
  relay port went away (an adb server restart drops it); re-add it with
  `adb -s "$SERIAL" reverse tcp:<port> tcp:<port>` for the relay port printed
  for that lab computer.
