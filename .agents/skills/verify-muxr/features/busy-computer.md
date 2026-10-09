# Stay connected to a busy computer

When the computer is overloaded (a big herd, a machine-wide stall), the phone keeps Home usable and says it is still connecting. It does not jump to "Computer unreachable" on the first missed heartbeat. Only a link that stays offline past the 30 s grace asks the relay why and explains it.

## Sub-features

- Home's tree, Live tiles and dials keep answering at 300 panes / 150 agents (host loop not starved by the herd lookup).
- A link that drops for less than the grace shows the busy "still connecting" card, never the unreachable card, then reopens by itself.
- A link that stays offline past the grace explains itself as before: the relay is up but the computer is not connected, or the relay itself is unreachable.
- A refused or revoked pairing still lands on its permanent card immediately.
- A Home worktree probe that times out on a busy computer does not raise an unhandled rejection.

## How to get to it (user POV)

Pair with the lab computer. With the computer stalled, reopen the app from cold and watch the card above the herd until the computer recovers.

## Driving it with the private stack

Preconditions: follow ../SKILL.md isolation. Use `perf/lib/fakeStack.mjs` (real relay and host from this checkout, fake Herdr) with `transport: 'adb'`, not the owner's host. Use one task-owned emulator under the home's emulator lock, with a release APK built by `perf/buildPrApk.mjs`.

1. Load without the phone: `node perf/homeLoad.mjs --minutes 5 --phones 2 --panes 300 --agents 150 --out report.json`. Expect zero failed `herdr.tree`/`pane.read`, dial open p95 well under the 20 s budget, and `linkOffline` 0. On the pre-fix host the same run failed nearly every request and every dial.
2. Start a fakeStack at 300 panes / 150 agents with `titleChurnHz: 0.2`, `adb reverse` its relay port, and pair the app by typing a minted code.
3. Freeze the lab host by its exact PID (`kill -STOP <hostPid>`), then cold-start the app (`am force-stop`, then `am start`), which is what a phone coming back to a busy computer pays. Capture at about 10, 25 and 40 s. Expect the "Your computer is very busy - still connecting" card, never "Computer unreachable". Resume (`kill -CONT`) at about 40 s and capture Home connected with the herd listed.
4. Repeat with a 100 s freeze. After the dial gives up (about 20 s) plus the 30 s grace, expect "Computer unreachable" with the relay-up "not connected" explanation. Resume, and expect it to clear by itself when the link reopens.
5. Save the screenshots and homeLoad reports outside the repo. Stop only the PIDs you started.

## Gotchas

- Freezing the host under an already-open link does not drop it: a 60 s freeze kept the header "connected" and the tiles caught up on resume. The not-available path is a fresh dial into a slow host, so drive the cold start.
- The release app's own JS cost grows with the herd: on the emulator it ran about 35% CPU at 6 panes, about 120% at 120 and about 155% at 300, where header taps stopped navigating. That is separate from the connection. A 2 Hz title churn on every pane (600 updates/s) is far beyond real Herdr; use `titleChurnHz` 0.2 or lower for the phone.
- A machine-wide stall under swap pressure freezes the lab, the relay and your sampler together. Read a lone slow tail in a homeLoad report against the relay's event-loop gaps before blaming the host.
- `onlineMachines` in relay `/health` counts every host on a shared relay, so it cannot tell the phone whether *its* computer is connected. Do not key phone wording on it.
