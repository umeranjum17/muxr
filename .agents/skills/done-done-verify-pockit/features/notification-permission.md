# Ask for notifications after pairing and say when they are off

Pairing a computer is the moment muxr asks for the notification permission:
the first connected Home after a pairing raises the system prompt once, and
only if muxr never asked before. Turning Settings > Notifications > An agent
needs you on asks again unless the system says it can no longer ask. While
notifications are off, Settings > Notifications says alerts cannot reach you,
and Home says so whenever an agent needs you, with a button that asks or opens
muxr's page in the system notification settings. Both go away once
notifications are on. Web and Android before 13 have no such permission and
show none of this.

## Sub-features

- `ask-after-pairing` a fresh install (`POST_NOTIFICATIONS: granted=false`,
  never asked) shows the system "Allow muxr to send you notifications?" prompt
  over Home within seconds of tapping Pair; a cold relaunch of an already paired
  app does not ask.
- `home-off-card` after Don't allow, Home shows "Know when an agent needs you"
  with Turn on (asks again) and Not now; after a second Don't allow it shows
  Open settings, which opens muxr's App notifications page.
- `home-missed-alert` after Not now, Home shows nothing until an agent needs
  you, then "Notifications are off" with "An agent needs you, but muxr cannot
  alert you while notifications are off." and the same button, no Not now.
- `settings-off-hint` Settings > Notifications reads Allow notifications Off and
  the footer "Notifications are off for muxr, so these alerts can't reach you.
  Tap Allow notifications to turn them on" (ending "in Android settings" once
  the system can no longer ask); Allow notifications then opens the system page
  with no prompt.
- `alerts-on-asks` turning An agent needs you off and on raises the prompt
  while the system can still ask, and never after the second Don't allow.
- `granted-clears` allowing notifications (prompt or system page) removes the
  Home card and the Settings hint and reads Allow notifications On.

## How to get to it (user POV)

- Install muxr, pair a computer, answer the prompt. Open Settings >
  Notifications. Leave an agent waiting on you and look at Home.

## Driving it with the private stack

Preconditions:

- `yarn build` and a release APK from `node perf/buildPrApk.mjs <out>` on an
  owned API 33+ emulator `SERIAL`, installed fresh (`adb install`, then
  `pm clear com.trymuxr.app`), and `dumpsys package com.trymuxr.app` reads
  `POST_NOTIFICATIONS: granted=false` with no `USER_SET` flag.

1. From the repo root, in its own shell with stdin attached:
   `SERIAL=$SERIAL node --input-type=module -e "$(< .agents/skills/done-done-verify-pockit/features/notificationLab.mjs)"`.
   It starts a fake stack with one idle agent (`umer-api`) and opens the
   pairing link on the phone. `adb -s $SERIAL reverse tcp:<relayPort> tcp:<relayPort>`
   is done by the fake stack. Tap `Pair`.
2. `ask-after-pairing`: dump the screen until
   `com.android.permissioncontroller` shows `Allow muxr to send you notifications?`;
   capture it. Tap `Don't allow`.
3. `home-off-card` and `settings-off-hint`: capture Home and Settings >
   Notifications. Toggle An agent needs you off and on: the prompt comes back;
   `Don't allow` again. Capture Home (Open settings) and Settings (footer ends
   "in Android settings"); tap Allow notifications and check
   `dumpsys activity activities` shows `AppNotificationSettings` resumed; back.
4. `home-missed-alert`: tap Not now on Home, then type `blocked` into the lab:
   the card returns as "Notifications are off". Capture it; type `idle` and it
   goes.
5. `granted-clears`: `pm grant com.trymuxr.app android.permission.POST_NOTIFICATIONS`
   (stands in for the system page's switch), bring muxr back to the front:
   Home has no card and Settings reads On with the plain footer.
6. Run the Visual check (`../SKILL.md`) on Home with the missed-alert card and
   on Settings > Notifications with the hint. Ctrl-C stops the lab.

## Gotchas

- Expo reports "never asked" (`undetermined`) only for asks expo made itself;
  an app data clear resets it, so `pm clear` before every fresh run.
- A cold relaunch never asks: only a pairing completed in this app run arms
  the ask. To see the prompt again, `pm clear` and pair again.
- On Android the first Don't allow can still be asked again; only the second
  makes it permanent (`canAskAgain` false), which is when Turn on becomes Open
  settings and the Settings footer names Android settings.
- `pm revoke` after a grant can kill the app; relaunch before capturing.
