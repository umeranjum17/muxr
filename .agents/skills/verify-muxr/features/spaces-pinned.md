# See pinned spaces on the phone's Spaces list

A space the user pins from its long-press menu leads the phone's Spaces list
under a quiet `Pinned` label, its card otherwise identical to an unpinned one;
every other space follows under `Spaces`.

## Sub-features

- `spaces-pin` long-press a space card -> `Pin to top` moves it under `Pinned`.
- `spaces-pinned-card` a pinned card shows chevron, state dot, name and agent
  count, and no pin glyph after the name.

## How to get to it (user POV)

- Home -> Spaces list -> long-press a space card -> `Pin to top`.

## Driving it with the private stack

Preconditions:

- `yarn build`, and a release APK from `node perf/buildPrApk.mjs <out>`
  installed on an owned emulator `SERIAL`. This drives the phone, so it uses
  `perf/lib/fakeStack.mjs` (real relay, host and E2EE pairing over a fake
  Herdr) instead of `../SKILL.md` Launch: the host's `--fake` source has no spaces.

- **Seed and pair.** From the repo root, in its own shell:
  `SERIAL=<serial> node --input-type=module < .agents/skills/verify-muxr/features/spacesLab.mjs`.
  It adds `api-server`, `infra` and `mobile-app` with `pi` agents named
  `umer-*`, opens the app's `muxr://pair` link and prints `lab ready`; tap
  `Pair`, then `Don't allow` on the notification prompt.
- **Pin.** Long-press `api-server` -> `Pin to top`, then `infra`. Both lead
  under `Pinned`; `mobile-app` stays under `Spaces`.
- **Capture** with `adb -s $SERIAL exec-out screencap -p`, in dark and light
  (`adb shell cmd uimode night yes|no`, then force-stop and relaunch the app)
  and at tablet width (`adb shell wm size 1600x2560 && adb shell wm density 320`;
  undo with `wm size reset && wm density reset`). `adb shell screenrecord`
  records the pin itself.
- Stop the lab with Ctrl-C (it stops only what it started).

## Gotchas

- The app reads the system theme at launch; a live `uimode` change shows the
  old theme until it is relaunched, and each launch re-asks for notifications.
- Pins are a phone-local preference: a reinstall or `pm clear` drops them.
- A header reading `offline` mid-run means the `adb reverse` tunnel to the
  relay port went away (an adb server restart drops it); re-add it with
  `adb reverse tcp:<port> tcp:<port>` for the relay port `lab ready` printed.
