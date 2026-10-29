# Just this phone

Home › first-run card › Just this phone starts an agent that runs on the phone
itself, with no computer. A person with nothing else signs in to the AI account
they already pay for (ChatGPT through `@byokit/accounts`), reads what that plan
charges ("Uses your ChatGPT plan."), sends one message and reads the reply. The
chat lives in one `PhoneLog` file in the app's documents directory, so reopening
the app continues it; a turn the app was killed in reads `interrupted` and the
session stays blocked until the person taps Try again. The agent has one tool,
an existing app capability (`set_theme`), and no shell or file access.

## Sub-features

- `phone-only-sign-in` tapping the card with no account signed in shows the
  sign-in step; the code card names the code to enter on ChatGPT and the chat
  opens signed in once it is approved.
- `phone-only-first-reply` the plan words show before the first send, and a sent
  message gets a reply that used the tool.
- `phone-only-reopen` killing the app mid-turn and reopening shows
  "Continue your chat", the turn as interrupted, and Try again sends it once.

## Driving it

- A release APK built with `EXPO_PUBLIC_MUXR_PHONE_AUTH_BASE=http://127.0.0.1:38911`
  and `EXPO_PUBLIC_MUXR_PHONE_API_BASE=http://127.0.0.1:38912`, the stand-in's ports.
- `node .agents/skills/done-done-verify-pockit/features/phoneOnlyLab.mjs --apk <apk> --evidence <dir> --avd-home <dir>`
  under the emulator lock (`flock -o -w 600 /tmp/fm-muxr-emulator.lock`). It boots
  its own emulator, `pm clear`s the app and runs `phoneStandIn.mjs`, a stand-in
  for the ChatGPT BYOKit routes (device-code sign-in and the model API).
- Pass: `journey.log` ends `RESULT done`; `flow/` holds the eight steps, two reopened chats are cited beside it, and the
  360/390/445/270 dp light and dark matrix is saved in `<evidence>-matrix` (one check judges at most 10 captures).

## Gotchas

- The reply is proven against the stand-in. A real ChatGPT reply needs the
  person's own credential, which a lab never copies.
- Hermes has no `crypto.randomUUID`; turn ids come from `expo-crypto`.
- The sign-in code card trips the visual check's container-overlap lead; the
  card is one container and the lead is a false positive.
- The composer is lifted by the measured keyboard height and clears the
  navigation bar; a fixed offset left Send under the keys on Android.
