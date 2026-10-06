# Add a second Claude account on iPhone and iPad

With a Claude account already signed in on the computer, the user adds a
second one from Settings › Accounts, names it, and lands back on the list under
an `Added …` notice. The notice's `Claude accounts: …` line names every
account exactly as the list right below it does, including the name the host
gives the other account when the new one takes a name already in use
(`Umer, Umer 2` over rows `Umer 2` and `Umer`).

## Sub-features

- `accounts-add` Add a Claude account › Open Claude sign-in › name sheet › Save.
- `accounts-added-notice` the notice's names equal the list's names.
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
  with a suggested name (observed prefilled `Umer` on 5fb08b9 builds, a
  separately tracked defect; it may differ). Clear the `Account name` field
  and enter `Umer` so the name collides with the found account. Start
  `xcrun simctl io <udid> recordVideo`, tap `Save`,
  and screenshot at leisure: the notice stays up until it is tapped (no timer).
  On builds before PR #680 it dismissed after 3.2 s, so capture within a second
  there. Stop the recording with SIGINT after the list capture. `axe describe-ui`
  reads both surfaces as text: the notice is one button labelled
  `Added Umer. Claude accounts: …`, each row `<name>, <email>, …`.
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
