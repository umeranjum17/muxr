# Keep a terminal pane alive across a reconnect

When the phone loses the relay or the computer for a while, an open terminal
pane keeps its last frame on screen, reads `Reconnecting…`, and attaches again
by itself once the link is back. No tap, and no internal words such as
`terminal:`, `link` or `stream` in what the pane says.

## Sub-features

- `terminal-relay-restart` the relay restarts under an open pane; the pane resubscribes when the computer answers again.
- `terminal-network-drop` the phone's route to the relay goes away for a while and comes back; same recovery.
- `terminal-last-frame` the pane's last output stays visible for the whole outage.
- `terminal-plain-words` a host refusal (pane open on another device, pane could not start) reads as a plain sentence.

## How to get to it (user POV)

- Home -> Panes -> a shell pane. Leave it open while the connection drops.

## Driving it with the private stack

Preconditions:

- `yarn build`, and a release APK from `node perf/buildPrApk.mjs <out>` installed
  on an owned emulator `SERIAL` (or the test phone under its keeper lock). The
  lab uses `perf/lib/fakeStack.mjs` (real relay, host and E2EE pairing over a
  fake Herdr with real per-pane shells) instead of `../SKILL.md` Launch.

1. `mkdir -p "$EVIDENCE"`, then from the repo root, in its own shell:
   `SERIAL=<serial> EVIDENCE=$EVIDENCE node --input-type=module -e "$(< .agents/skills/verify-muxr/features/terminalReconnectLab.mjs)"`.
   Keep stdin attached. Tap `Pair` on the phone, then `Don't allow` on the notification prompt.
2. Enter `open`: the fake's shell pane opens. Type something recognisable into it
   (`echo Umer reconnect check`) so the last frame is easy to see.
3. Start `adb -s $SERIAL shell screenrecord --time-limit 120 /sdcard/reconnect.mp4`.
4. Enter `relay`: the lab kills its relay by PID and starts it again on the same
   port. Then `net 20`: it removes the phone's `adb reverse` tunnel for 20 s and restores it.
5. Watch without touching the phone: the chip under the terminal reads
   `Reconnecting…` over the unchanged last frame, then the pane is live again;
   type into it to prove input flows.
6. `quit`. The lab writes `$EVIDENCE/lab-timeline.log` (each cut and restore)
   and `$EVIDENCE/host-relay.log` (`link relay:` transitions and each
   `link: terminal stream attached` — one per resubscribe). Pull and inspect
   the recording's frames; screenshots of the reconnecting and recovered states
   go next to them.

## Gotchas

- Before the fix, a reconnect showed `terminal: link refused the pane stream` and
  gave up after about 2.5 minutes; a baseline APK reproduces it with the same steps.
- A host refusal is not retried: `This pane is open on another device. Tap to use it here.`
  is the expected end state when another device took the pane.
- `adb reverse --remove` may leave an already-open socket alive on some adbd
  versions; if the header never reads offline, rely on the `relay` cut.
- The lab never prints the pairing offer to its logs; keep it that way.
