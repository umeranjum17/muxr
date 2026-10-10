# Add a second Claude account on iPhone and iPad

With a Claude account already signed in on the computer, the user adds a
second one from Settings › Accounts, names it, and lands back on the list under
an `Added …` notice. The notice names only the account just added — its
host-resolved name in the title and that account's email below — and sits in
the list's own layout flow, pushing the rows down instead of floating over the
first one.

## Sub-features

- `accounts-add` Add a Claude account › Open Claude sign-in › name sheet › Save.
- `accounts-added-notice` the notice names only the added account, and at the
  largest text size it wraps to the full name in the flow above the list, which
  stays fully visible below it.
- `accounts-rows-distinct` at the largest text size, rows of one provider that
  share a name and email stay tellable apart: the name wraps to two lines, the
  email stays on one line and never breaks mid-word (native `ellipsizeMode`
  `middle` keeps both ends; web shortens the local part so `start…@domain`
  stays), and the usage line (`40% left · max`) differs.
- `accounts-signin-states` in-progress banner, cancel, refusal, re-sign-in without the name step.
- `accounts-remove` row › Remove › Remove resets to one account.

## How to get to it (user POV)

- Home › Settings › Accounts (`muxr://settings/accounts`) › Add a Claude account.

## Driving it with the private stack

Preconditions:

- `yarn build` on the machine running the stack; a Release simulator `muxr.app`
  built on the Mac (yarn build, `syncIosFramework.mjs --verify`, pod install,
  `xcodebuild -configuration Release -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO`);
  iPhone and iPad simulators you created yourself (`xcrun simctl create`), and
  `axe` on the Mac. This drives the app, so it uses `perf/lib/fakeStack.mjs`
  (real relay, host, BYOKit kits and E2EE pairing over a fake Herdr) instead of
  `../SKILL.md` Launch.

- **Lab.** From the repo root, in its own shell:
  `node --input-type=module < .agents/skills/verify-muxr/features/accountsLab.mjs`.
  It prints `lab ready: relay 127.0.0.1:<port>` and a `muxr://pair#…` link.
  A simulator shares the Mac's loopback, so a stack on Linux reaches it with
  `ssh -N -o ExitOnForwardFailure=yes -R 127.0.0.1:<port>:127.0.0.1:<port> <mac>`.
- **Pair.** `xcrun simctl openurl <udid> 'muxr://pair#…'`, tap `Open`, then
  `Pair`; Home shows `connected`. `kill -USR1 <lab pid>` mints the next link.
- **Add.** `xcrun simctl ui <udid> appearance light|dark`, relaunch, open
  Accounts, tap `Add a Claude account`, `Open Claude sign-in`. The stand-in
  signs in as `umer.work@example.com` at once and the name sheet opens
  prefilled with a name nobody already holds (`Umer Work` in this lab).
  Clear the `Account name` field
  and enter `Umer` so the name collides with the found account: the hint must
  preview the resolved names (`Umer and Umer 2`), as the list will show them. Start
  `xcrun simctl io <udid> recordVideo`, tap `Save`,
  and screenshot at leisure: the notice stays up until it is tapped (no timer).
  On builds before PR #680 it dismissed after 3.2 s, so capture within a second
  there. Stop the recording with SIGINT after the list capture. `axe describe-ui`
  reads both surfaces as text: the notice is one button labelled
  `Added Umer. umer.work@example.com`, each row `<name>, <email>, …`.
- **Largest text size.** Repeat the add with the simulator at the largest
  accessibility content size (`xcrun simctl ui <udid> content_size
  accessibility-extra-extra-extra-large`, the AX5 slot) and a long account name
  (e.g. `Umer Work Eastern Region Client Projects`) so the `Added …` title wraps
  across lines. The notice sits in the list's own flow above the first row: it
  must show the whole name and the added account's email — wrap, never clip or
  ellipsize — and the first account row must stay fully visible below it, not
  covered. Reset the content size to `large` afterwards.
- **Distinct rows.** With the list seeded so several accounts share one name and
  one email (the Android/PWA lab fixture in `data/pock-accounts-rows-distinct1`
  does), each row must still read apart at the largest text: the name wraps to
  two lines, the email stays on one line without breaking mid-word (native
  middle ellipsis keeps both ends, web `start…@domain`), and the `…% left · max`
  line beneath differs, so no two rows truncate to one shared `Name …` / `email@…`
  prefix.
- **Sign-in states.** The lab prints its `lab home`. While `signin-hold` exists
  there the stand-in's sign-in stays open, so the tab shows the `Signing in …`
  banner with `Cancel`; removing it finishes the sign-in, and with `signin-fail`
  also present it ends refused (`Sign-in didn't finish` with `Try again` and
  `Close`). To sign an added account out for a re-sign-in, delete the
  `lab-account.json` in its account folder; its row then offers sign-in again,
  and finishing it returns to Accounts with `<name> is signed in`, no name sheet.
- **Reset** with the `umer.work@example.com` row › `Remove` › `Remove`, so the
  next theme or build starts from one account again.
- A before/after pair needs only one native build: the fix under test is JS,
  so restore the old file and rerun the same `xcodebuild` (it re-bundles in
  minutes). Check `buildCommitSha` in `EXConstants.bundle/app.config`.

## Gotchas

- The first text field on a fresh simulator raises the keyboard's swipe-typing
  tip; tap its `Continue` before the screenshot.
- `axe tap --label` taps the first match; with a sheet open, `Remove` and
  `Cancel` exist twice. Tap the last (frontmost) match by its frame.
- Delete the simulators you created, and the Mac's DerivedData, when done;
  never boot, shut down or claim a simulator another lane created.
