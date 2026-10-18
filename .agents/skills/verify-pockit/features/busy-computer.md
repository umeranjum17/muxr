# Stay connected to a busy computer

When the computer is overloaded (a big herd, a machine-wide stall), the phone keeps Home usable and says the computer is busy and reconnecting. It does not jump to "Computer unreachable" on the first missed heartbeat. A link that was online keeps the busy card while the host is reconnecting. A genuinely offline host or a start that never connected asks the relay why and explains it.

## Sub-features

- Home's tree, Live tiles and dials keep answering at 300 panes / 150 agents (host loop not starved by the herd lookup).
- An unchanged 300-pane herd sends no periodic artifact or plugin events; admission polling never replays it. Connecting and returning clients receive their own full artifact snapshot without waking another phone.
- A link that drops for less than the grace shows the busy "<computer> isn't answering, likely busy." card, never the unreachable card, then reopens by itself.
- A stalled but connected Herdr keeps the busy/reconnecting card indefinitely, with no restart command; when Herdr answers again, the link and agents recover automatically. A genuinely offline host retains the normal recovery card.
- The host journals Herdr's kit-reported stall and recovery (`journalctl --user -u muxr.service`); `scripts/diagnostics/application/checkHerdrStallE2E.mjs` drives this on a lab Herdr.
- A refused or revoked pairing still lands on its permanent card immediately.
- A Home worktree probe that times out on a busy computer does not raise an unhandled rejection.

## How to get to it (user POV)

Pair with the lab computer. With the computer stalled, reopen the app from cold and watch the card above the herd until the computer recovers.

## Driving it with the private stack

Preconditions: follow ../SKILL.md isolation. Use `perf/lib/fakeStack.mjs` (real relay and host from this checkout, fake Herdr) with `transport: 'adb'`, not the owner's host. Boot one task-owned emulator through `perf/lib/androidEmulator.mjs` (`bootOwnedEmulator`): it creates the AVD under one explicit `ANDROID_AVD_HOME`, waits for `sys.boot_completed` **and** the package manager, and pins the discovered serial for every adb call. The release APK comes from `perf/buildPrApk.mjs`. The whole native matrix is one command — `node perf/emulatorMatrix.mjs --before-root <built commit> --after-root . --apk <apk> --avd <name> --avd-home <dir>` samples the phone's JS thread over a quiet herd for each built host.

1. Load without the phone: `node perf/homeLoad.mjs --minutes 5 --phones 2 --panes 300 --agents 150 --out report.json`. Expect zero failed `herdr.tree`/`pane.read`, dial open p95 well under the 20 s budget, and `linkOffline` 0. On the pre-fix host the same run failed nearly every request and every dial.
2. Start a fakeStack at 300 panes / 150 agents with `titleChurnHz: 0.2`, `adb reverse` its relay port, and pair the app by typing a minted code.
3. Freeze the lab host by its exact PID (`kill -STOP <hostPid>`), then cold-start the app (`am force-stop`, then `am start`), which is what a phone coming back to a busy computer pays. Capture at about 10, 25 and 40 s. Expect the "<computer> isn't answering, likely busy." card, never "Computer unreachable". Resume (`kill -CONT`) at about 40 s and capture Home connected with the herd listed.
4. Repeat with a 100 s freeze. After the dial gives up (about 20 s) plus the 30 s grace, expect "Computer unreachable" with the relay-up "not connected" explanation. Resume, and expect it to clear by itself when the link reopens.
5. The 18 Oct shape, an open link frozen past the grace: with Home connected, freeze the lab Herdr and host together by exact PID for 90 s. Capture at about 50 s and 80 s: the busy card with "No answer for …", no `muxr daemon restart` command, never "Computer unreachable". Resume and capture Home connected with the herd listed. Capture at 393 dp in light and dark.
6. Before the native matrix, run `node perf/artifactReplay.mjs --out "$EVIDENCE/artifact-replay.json"` under a task-owned HOME/XDG/TMPDIR. It starts fresh real host/relay processes, waits for the host's relay-ready line before pairing, and proves 30 s of zero idle frames at 300 panes; a second client's 300-pane artifact snapshot and one cache invalidation; targeted reconnect; public `muxr share` with byte-identical storage; and live task, lifecycle, attention and unread changes. Expect `outcome: pass`. This is host/link proof, not a native CPU measurement.
7. Save the screenshots and homeLoad reports outside the repo. Stop only the PIDs you started.

## Gotchas

- `avdmanager` and `emulator` can resolve different default AVD homes (avdmanager has defaulted under `~/.config/.android` while the emulator searches `$ANDROID_AVD_HOME`, `$ANDROID_SDK_HOME/avd`, then `$HOME/.android`). An AVD created without an explicit home is then invisible to the emulator, which exits "Unknown AVD name" and leaves a boot wait on `sys.boot_completed` burning its whole timeout. Create and launch with the same explicit `ANDROID_AVD_HOME`; `perf/lib/androidEmulator.mjs` does. A launcher that only overrides the emulator's home is exactly this bug.
- Freezing the host under an already-open link does not drop it: a 60 s freeze kept the header "connected" and the tiles caught up on resume. The not-available path is a fresh dial into a slow host, so drive the cold start.
- The release app's own JS cost grows with the herd: on the emulator it ran about 35% CPU at 6 panes, about 120% at 120 and about 155% at 300, where header taps stopped navigating. That is separate from the connection. A 2 Hz title churn on every pane (600 updates/s) is far beyond real Herdr; use `titleChurnHz` 0.2 or lower for the phone.
- A machine-wide stall under swap pressure freezes the lab, the relay and your sampler together. Read a lone slow tail in a homeLoad report against the relay's event-loop gaps before blaming the host.
- `onlineMachines` in relay `/health` counts every host on a shared relay, so it cannot tell the phone whether *its* computer is connected. Do not key phone wording on it.
