# OpenCode agents start on Muse Spark 1.3 Contributor

When muxr starts an OpenCode agent on one of its own OpenCode (Go) accounts,
the agent opens on `opencode-go/muse-spark-1.3-contributor` instead of
OpenCode's own default (`opencode-go/gpt-5.6-luna`), so the first reply needs
no manual model switch. The phone shows no picker for this; the footer reads
`Muse Spark 1.3 Contributor · OpenCode Go`.

## Sub-features

- `opencode-go-default-model` a new OpenCode agent started from the phone on
  a signed-in OpenCode Go account opens on
  `opencode-go/muse-spark-1.3-contributor`, set as `model` in the pane's
  `OPENCODE_CONFIG_CONTENT` (`opencodeConfigEnv`) when no config OpenCode merges
  names a model; muxr writes no config file, and a config it cannot parse is
  left alone. Its footer names Muse Spark 1.3 Contributor and its first reply
  comes from that model, on OpenCode 1.19 and 2.x alike (2.x has no `--model`
  flag and exits on it).
- `opencode-go-user-model-kept` a model the user set in a config stands.
- `opencode-go-other-launches-unchanged` every other kind launches exactly as
  before, and an OpenCode start with no plan account adds no model. The only
  launch args muxr adds are `--standalone` on OpenCode 2.x, which gives each
  account a private background server instead of the one fixed port 2.x
  otherwise shares (`opencodeLaunchArgs` in `plans/opencodeAccounts.ts`).
- `opencode-signed-in-state` once the key is typed, Settings › Accounts reads
  the OpenCode row as `Signed in` (it has no email to show) and New agent
  reads OpenCode as `Signed in`, not `Sign-in not checked`, with no app
  restart. The host takes the typed key on the next `plans.status` read and
  the BYOKit accounts kit saves it; OpenCode reads it from the kit's account
  folder at launch.

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
- An OpenCode Go API key. It is typed into the sign-in tab's hidden key prompt
  only, never printed, logged, recorded, or screenshotted: stop any recording
  while it goes in and keep stills away from the prompt box until it clears.

1. Relay on a kernel-picked port owned via its own stdout line, host against
   the lab Herdr session (`HERDR_SESSION` + a private `MUXR_HOME`), pair the
   emulator (`adb reverse` + the `muxr://pair#…` link, approve on the owner
   socket and stay connected until the phone proves itself).
2. Settings › Accounts › Add an OpenCode account › Open OpenCode sign-in. In the
   tab, paste the OpenCode Go key at the hidden `Key (hidden):` prompt. The
   account row reads `Signed in` and New agent lists OpenCode as `Signed in`
   (sub-feature `opencode-signed-in-state`).
3. Start a new OpenCode agent from the phone and read its footer: before the
   fix it reads `GPT-5.6 Luna · OpenCode Go`; after the fix `Muse Spark 1.3
   Contributor · OpenCode Go`. Ask for one short reply from the agent screen
   and capture footer plus reply.
4. The launch flow test covers the pane config, the kept user model, and that
   only OpenCode 2.x launches pass `--standalone`.

## Gotchas

- An OpenCode agent already running when the sign-in lands keeps the folder it
  started in and never reads the new account's key, so its row stays
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
