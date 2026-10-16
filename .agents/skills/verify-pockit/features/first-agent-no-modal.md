# Open the first agent with no notifications modal over it

A newcomer who starts their first agent lands straight in it. No "Allow muxr
notifications?" or "Show live agent updates?" modal covers the new agent: the
Home card "Know when an agent needs you" is the one place that asks for the
notification permission, and Settings > Notifications keeps the permission and
Android's Live agent updates rows for anyone who said Not now.

## Sub-features

- `first-agent-no-modal` from a fresh install with notifications not granted,
  Home's Start an agent -> Claude Code -> Start opens the agent and no modal
  appears over it in the next 30 s.
- `notifications-card-asks` Home still shows the "Know when an agent needs you"
  card before the agent starts.
- `live-updates-row` Settings > Notifications > Live agent updates still opens
  Android's Live Updates setting (the modal's old Open settings target).

## How to get to it (user POV)

- Install, pair, then on Home tap `Start an agent`, pick `Claude Code`, tap
  `Start Claude Code in …`, and watch the agent open.

## Driving it with the private stack

Preconditions:

- `yarn build` and a release APK of the candidate (`perf/buildPrApk.mjs`, with
  `-PreactNativeArchitectures=arm64-v8a` for a real phone) on an owned emulator
  or the test phone under its keeper lock. A real Herdr lab
  (`HERDR_LAB_HELPER`, `FM_HERDR_LAB_STATE_DIR`) and `claude` on PATH.

1. Start the lab with no panes, from the repo root in its own shell, stdin
   attached: `KINDS= EVIDENCE=$EVIDENCE node --input-type=module -e "$(< .agents/skills/verify-pockit/features/terminalLatestLab.mjs)"`.
   Claude Code in the lab answers from the canned fixture, so no account is used;
   the picker may still read `Needs sign-in`, and it starts all the same.
2. Fresh newcomer state for muxr only: install the APK, then `pm clear
   com.trymuxr.app` (see Gotchas when the phone refuses it). Check
   `dumpsys package com.trymuxr.app` reads `POST_NOTIFICATIONS: granted=false`.
3. Enter `pair`, `adb reverse tcp:<relayPort> tcp:<relayPort>` (the port is
   `relayPort` in the lab's `muxr/selfhost.json`), open the written
   `muxr://pair#…` link with `am start`, tap `Pair`.
4. On Home check the notifications card, then `Start an agent` -> `Claude Code`
   -> `Start Claude Code in …`. From that tap take a screenshot every 0.5 s for
   30 s (a phone that refuses `screenrecord` gets only these; see Gotchas for
   the fast capture) and, beside it, `uiautomator dump` every second for either
   modal title.
5. Pass: the agent screen is the only thing on screen in every frame and no dump
   holds `Allow muxr notifications?` or `Show live agent updates?`. Before the
   fix `Allow muxr notifications?` was on screen 0.6 s after the tap, over the
   screen transition, and stayed (Android 16 test phone).
6. `quit` stops the lab and tears its Herdr session down.

## Gotchas

- The modal fired only on Android, only once the herd had a working or
  waiting agent, so a Home with no agents never shows it; start a real agent.
- With notifications already granted but Android Live Updates off, the old
  code raised `Show live agent updates?` instead; check both titles.
- Some phones refuse `pm clear` and `pm revoke` from the shell (OnePlus,
  Android 16: no `CLEAR_APP_USER_DATA`); there a fresh newcomer state is a
  reinstall of muxr itself, which also leaves notifications not granted.
- `screencap -p` over adb took ~2.4 s a frame on that phone; for 0.5 s
  frames run `screencap` (raw) on the phone in a loop, stamp each file with
  the phone's `date +%s%3N`, pull afterwards and encode with ffmpeg (skip the
  16-byte header, `rgba`).
