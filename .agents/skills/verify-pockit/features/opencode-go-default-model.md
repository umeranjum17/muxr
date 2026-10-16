# OpenCode agents start on Muse Spark 1.3 Contributor

When muxr starts an OpenCode agent on one of its own OpenCode (Go) accounts,
the agent opens on `opencode-go/muse-spark-1.3-contributor` instead of
OpenCode's own default (`opencode-go/gpt-5.6-luna`), so the first reply needs
no manual model switch. The phone shows no picker for this; the footer reads
`Muse Spark 1.3 Contributor · OpenCode Go`.

## Sub-features

- `opencode-go-default-model` a new OpenCode agent started from the phone on
  a signed-in OpenCode Go account opens on
  `opencode-go/muse-spark-1.3-contributor`, set as `model` in the account's own
  OpenCode config (`<account>/.config/opencode/opencode.jsonc` or
  `opencode.json`) when no config there names a model; a config muxr cannot
  parse (for example JSONC with comments) is left untouched. Its footer names Muse
  Spark 1.3 Contributor and its first reply comes from that model, on OpenCode
  1.19 and 2.x alike (2.x has no `--model` flag and exits on it).
- `opencode-go-user-model-kept` a model the user set in that config stands.
- `opencode-go-other-launches-unchanged` every other kind launches exactly as
  before, and an OpenCode start with no plan account writes no config. The only
  launch args muxr adds are `--standalone` on OpenCode 2.x (its sign-in shell
  included), which gives each account a private background server instead of the
  one fixed port 2.x otherwise shares (`opencodeLaunchArgs` in
  `plans/opencodeAccounts.ts`).
- `opencode-signed-in-state` once the sign-in lands, Settings › Accounts reads
  the OpenCode row as `Signed in` (it has no email to show) and New agent
  reads OpenCode as `Signed in`, not `Sign-in not checked`, with no app
  restart. The host reads OpenCode sign-ins fresh on each `herdr.agentKinds`
  read, outside the 30 s catalog cache.

## How to get to it (user POV)

- Home › Start an agent › OpenCode › Start, then ask anything; or the Home
  composer with an OpenCode kind. The agent screen footer names the model.

## Driving it with the private stack

Preconditions:

- `yarn build`; a real Herdr lab session of your own (never `default`), the
  real `opencode` binary first on the lab `PATH`; a release APK on an
  emulator you started yourself (`-memory 2048 -cores 2 -no-audio`,
  density 420 — at density 640 opening the keyboard crashes OpenCode 1.18.x).
  A host built before the fix starts agents on Luna; the fixed host starts
  them on Muse Spark 1.3 Contributor.
- An OpenCode Go API key. It is typed into OpenCode's own masked key field
  only, never printed, logged, recorded, or screenshotted: stop any recording
  while it goes in and keep stills away from the prompt box until it clears.

1. Relay on a kernel-picked port owned via its own stdout line, host against
   the lab Herdr session (`HERDR_SESSION` + a private `MUXR_HOME`), pair the
   emulator (`adb reverse` + the `muxr://pair#…` link, approve on the owner
   socket and stay connected until the phone proves itself).
2. Settings › Accounts › Add an OpenCode account › Open OpenCode sign-in.
   In the tab, filter the provider list until it reads `(1 match)` on
   `OpenCode Go` and confirm with a real Enter key (text plus Enter sent
   together can confirm the default `OpenCode (recommended)` entry instead),
   then enter the key. The account row reads `Signed in` and New agent
   lists OpenCode as `Signed in` (sub-feature `opencode-signed-in-state`).
3. Start a new OpenCode agent from the phone and read its footer: before the
   fix it reads `GPT-5.6 Luna · OpenCode Go`; after the fix `Muse Spark 1.3
   Contributor · OpenCode Go`. Ask for one short reply from the agent screen
   and capture footer plus reply.
4. The launch flow test covers the config write, the kept user model, and that
   only OpenCode 2.x launches pass `--standalone`.
5. OpenCode 2.x: sign the account in on 1.19 first (2.x carries that sign-in
   over; a fresh 2.x sign-in lives only in its `opencode.db`, which muxr does
   not read yet), then put 2.x first on the lab `PATH` and start agents.

## Gotchas

- OpenCode's `auth login` provider search confirms whatever is selected when
  Enter lands: wait for `(1 match)` on `OpenCode Go` first, or the key lands
  on the wrong provider and login fails with `Unexpected error`.
- An OpenCode agent already running when the sign-in lands keeps the home it
  started in and never reads the new account's root, so its row stays
  unsigned (`OpenCode · opencode · Idle`) until a new agent starts. That is
  OpenCode's own behaviour, a known limitation and follow-up, not a restart
  flow.
- A prompt the Home composer starts an agent with that the agent drops comes
  back as not sent; see [home-composer-first-prompt.md](./home-composer-first-prompt.md).
- An OpenCode update prompt (`v1.19.0`) may cover the new agent: dismiss it
  with `esc` before reading the footer.
- Type the diagnostic prompt as plain text (`%s` for spaces over adb, or
  `checkFocusedSecretTyping.mjs` — see the skill's Typing note). URL-encoded
  input lands verbatim in the TUI and reads as a harness defect, not a model
  defect: the PR #843 proof's `Reply%20with%20exactly:%20spark-ok` was typed
  that way by the harness.
