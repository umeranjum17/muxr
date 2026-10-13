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
  `opencode.json`) when no config there names a model. Its footer names Muse
  Spark 1.3 Contributor and its first reply comes from that model, on OpenCode
  1.19 and 2.x alike (2.x has no `--model` flag and exits on it).
- `opencode-go-user-model-kept` a model the user set in that config stands.
- `opencode-go-other-launches-unchanged` every other kind, the sign-in shell,
  and an OpenCode start with no plan account launch exactly as before (no
  args, no config written).

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
   then enter the key. The account row signs in.
3. Start a new OpenCode agent from the phone and read its footer: before the
   fix it reads `GPT-5.6 Luna · OpenCode Go`; after the fix `Muse Spark 1.3
   Contributor · OpenCode Go`. Ask for one short reply from the agent screen
   and capture footer plus reply.
4. The launch flow test covers the config write, the kept user model and that
   no launch passes args.
5. OpenCode 2.x: sign the account in on 1.19 first (2.x carries that sign-in
   over; a fresh 2.x sign-in lives only in its `opencode.db`, which muxr does
   not read yet), then put 2.x first on the lab `PATH` and start agents.

## Gotchas

- OpenCode's `auth login` provider search confirms whatever is selected when
  Enter lands: wait for `(1 match)` on `OpenCode Go` first, or the key lands
  on the wrong provider and login fails with `Unexpected error`.
- The phone's account row and agent kind list can stay stale (`Signed out`,
  `Sign-in not checked`) after the sign-in lands; the host still resolves the
  signed-in account for the start. Restarting the app refreshes the rows.
- A prompt the Home composer starts an agent with that the agent drops comes
  back as not sent; see [home-composer-first-prompt.md](./home-composer-first-prompt.md).
- An OpenCode update prompt (`v1.19.0`) may cover the new agent: dismiss it
  with `esc` before reading the footer.
