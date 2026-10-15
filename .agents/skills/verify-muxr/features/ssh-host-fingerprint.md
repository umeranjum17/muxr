# Confirm the SSH host fingerprint before signing in

Direct SSH first shows the server fingerprint for comparison with the provider console. Cancelling sends no login material; confirming pins the key before authentication. A changed key is refused on Android and iOS, including credential verification, reconnect and public-key installation.

## Sub-features

- First-run SSH and Settings > Connection share the existing SSH validator and fingerprint review.
- The native fingerprint probe handshakes without authenticating; it never installs anything.
- Authenticated native operations require a pin, including reuse of an existing tunnel.
- Pairing and device-grant consent still run through the ordinary link flow.

## How to get to it (user POV)

Choose SSH on the first-run connection chooser, fill in the SSH login and paste the lab computer's link offer. Confirm pairing; compare the fingerprint before choosing **Fingerprint matches**. Alternatively, pair the lab computer normally, then open Settings > Connection > Direct SSH and save the login.

## Driving it with the private stack

Preconditions: follow the skill's private relay/`--fake` host launch without starting a real Herdr session. Use only a task-owned SSH container, freshly generated RSA host keys and a disposable account named Umer; never mount a real `.ssh` directory. This feature needs no host installation or Herdr lifecycle commands.

1. Generate two RSA host keys with `ssh-keygen -t rsa -b 2048 -N '' -f <scratch>/host-a` and `host-b`. Record both public fingerprints with `ssh-keygen -lf <key>.pub -E sha256`. Configure the container's sshd with only host-a, password authentication and `LogLevel DEBUG3`; use a task-owned port and capture its logs privately.
2. Build the candidate release APK with `node perf/buildPrApk.mjs <scratch>/build` through the memory gate. Start a private emulator with its AVD home under task scratch. Every adb command must specify its owned serial.
3. Install the APK and drive the existing SSH screen with the lab address, account and password. Generate the offer from the private host with `MUXR_HOME=<scratch>/muxr-home node scripts/cli.mjs pair`; keep the offer private.
4. At **Check SSH fingerprint**, compare the entire displayed fingerprint to host-a's public fingerprint. Capture the dialog and sshd logs. Assert the server has received no authentication request, command or forward before confirmation. Cancel; assert that remains true.
5. Repeat, confirm **Fingerprint matches**, and finish ordinary pairing/grant consent. Assert sshd now records authentication and the app stores host-a's pin. Reconnect once with the same key.
6. Stop only the SSH container this run started. Restart it at the same address/port with host-b, preserving the app's paired data. Reconnect or save SSH again; capture the plain changed-fingerprint refusal and assert no authentication or command reaches host-b. Do not clear the pin to make this test pass.
7. Run `npx vitest run apps/mobile/sources/connection/sshAfterPairing.spec.ts` for the existing route journey's blocked-before-consent and cancellation assertions. Where no iOS simulator is available, retain a native policy spec proving the missing-pin/reused-pin guards and the probe's return occur before `libssh2_userauth_*`, and report the simulator limitation explicitly.
8. Run the skill's Visual check for the fingerprint dialog and changed-key message at 393/270 dp, light/dark, font 1.0/2.0, including the scrolled end if necessary. Direct SSH is native-only (`sshTunnelAvailable()` is false on web), so the installed PWA has no visible change and needs no capture.
9. Hold the narrow dialog: at 270 dp with font 2.0 it must open at the top (title and intro visible), keep both buttons fully visible and tappable at their visible glyphs, and reach the whole `SHA256:` fingerprint and `No login details have been sent.` with at most a short message scroll — never clipped mid-glyph, never under the buttons. Android's dialog must be opaque: the settings text behind must not show through its fingerprint or buttons. The pre-fix platform alert failed this (fingerprint below the fold, CANCEL half-clipped and dead at its glyphs); the in-app dialog (`SshFingerprintDialog`) holds it. Re-trigger per cell by saving Connection settings against the alternate lab port (each new host/port needs a fresh confirm; Cancel keeps the route), not by re-pairing.

Record exact child/container identities and stop the private emulator, SSH container, relay and host immediately after proof. Keep public-key fingerprints and reviewed screenshots; remove private keys, offers and scratch state.

## Gotchas

- A fingerprint probe sends the SSH handshake, not login secrets. Logs showing a TCP connection are not an authentication failure.
- A server with several host keys may negotiate a different fingerprint. This lab offers only RSA; Ed25519 support is a separate task.
- Changing username or relay port on the same host/SSH port must retain the pin.
- Never use a phone's stored-pairing reset as the changed-key proof: that creates a fresh trust decision rather than testing refusal.
- A build or JS platform double does not prove that a native server received no credentials. Preserve the SSH server log for both boundaries.
- OpenSSH 10 penalises sources whose connections never authenticate, which is exactly what a cancelled fingerprint probe is. A lab that cancels once per matrix cell sets `PerSourcePenalties no`, or later cells are refused before the handshake.
- A native pairing offer lives about two minutes (`pairMs`, capped at five; the lab pairing socket rebuilds the intent without a lifetime, so no extension is possible). Mint it last: deliver it with `adb shell am start -a android.intent.action.VIEW -d 'muxr://pair?offer=<text>'` (the pair screen reviews `routeParams.offer` directly) instead of racing the clock with typed input.
- When typing into the app is unavoidable, type at most ~100 characters per `adb shell input text` call: one 300-character call lands truncated, chunks land whole. Verify the landed length from a `uiautomator` dump before submitting.
- Tap only from a settled dump (two identical dumps in a row after a fling), with the keyboard closed; a tap with the keyboard open can land on the keys and a blind `keyevent 4` then pops the route instead of closing the keyboard.
