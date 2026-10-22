# Add a Claude account from the phone

Accounts › Add a Claude account › Open Claude sign-in opens Claude's own
sign-in in a new tab; the person pastes the code into that tab's composer and
taps Send, and once Claude says it is signed in the host closes the tab and the
phone moves on to "Name this account", then the Added notice. The host owns the
tab (`plans.add` / `plans.status` / `closeSignInTab` in
`apps/host/src/requests/application/createRequestDispatcher.ts`, the script in
`apps/host/src/plans/planSignIn.ts`); the phone's steps are `AddAccountSheet`,
`SignInBanner` and the naming sheet in
`apps/mobile/sources/plans/presentation/AccountFlows.tsx`.

## Sub-features

- `add-account-signed-in` the code is sent once, the sign-in tab closes and
  the flow lands on "Name this account" signed in as the new email.
- `add-account-named` Save shows the Added notice on the Accounts screen.

## Driving it on a lab Herdr

- `yarn build`, a release APK from `node perf/buildPrApk.mjs <out>`, and a
  Herdr lab helper in `HERDR_LAB_HELPER` (see `linkHerdrLab.mjs`); take the
  emulator lock as in `../SKILL.md`.
- `node .agents/skills/done-done-verify-pockit/features/addAccountLab.mjs <apk> <evidence> <labRoot>`
  with a fresh, short `<labRoot>` per run (`mktemp -d ~/.cache/fms/aa.XXXX`).
  A stand-in `claude` answers `auth login` like the real 2.1.x CLI: it waits
  for a `code#state` line, prints `Login successful.`, and keeps its prompt
  open a few seconds more, where any further line prints `Invalid code...`.
  Pass `-` for `<apk>` to send the code through `session.prompt` from the lab
  link with no phone.
- Pass: `journey.log` ends `PASS`; `sign-in-lines.txt` holds exactly one line;
  `4-name-this-account.png` shows "Name this account" signed in as
  `umer.work@example.com`; `5-added-notice.png` shows the Added notice;
  `add-account.mp4` records the whole add.

## Gotchas

- Herdr opens the sign-in tab as the only tab of a new workspace when none
  holds the home folder, so its close needs the workspace scope. With tab
  scope only, every `plans.status` after a good sign-in answered "Couldn't
  close the sign-in tab" and the phone's banner waited forever.
- `plans.add` installs Herdr's Claude hook through Herdr, and the guarded lab
  helper pins every Herdr call's `CLAUDE_CONFIG_DIR` to its own home: the lab
  creates that folder so the install succeeds (it lands in the lab's home,
  not the account's folder).
- The kit runs the login under `env -i`: a variable set for the lab does not
  reach the stand-in, so its behaviour is fixed in the script itself.
- Herdr sees `claude` in the sign-in tab within about a second, so the phone
  routes the tab as a Claude agent and the composer sends through
  `session.prompt` (trimmed text, one Enter), not as shell keystrokes.
