# Clean-room new-user smoke

This is the release gate for the experience a first-time open-source user gets. Run it from public artifacts, not the maintainer checkout. Paid providers are excluded unless the owner approves a separately costed smoke.

## Test matrix

Primary gate: clean Linux VM plus a fresh API 36 Android emulator. Follow-up documentation checks: macOS and WSL. Use a new temporary HOME, muxr state directory, relay port, git repository, Herdr workspace, and Android profile. Never reuse maintainer credentials or state.

## Flow

1. **Acquire the public release**
   - Clone the public GitHub repository anonymously at the release tag.
   - Verify the tag, source archive checksum, Apache-2.0 license, NOTICE, and Android artifact checksum.
2. **Install from zero**
   - Install only the documented Node 22+, Yarn 1.x, Git, Herdr, JDK/Android prerequisites.
   - Install the published CLI with `npm install -g --ignore-scripts @trymuxr/cli`, verify `muxr version`, then clone the matching public tag and run `yarn install --frozen-lockfile`, `yarn build`, and `node scripts/diagnostics/application/runSuite.mjs`.
   - In a second empty npm prefix, download `https://raw.githubusercontent.com/umeranjum17/muxr/main/install.sh` completely, run it with the exact release version, and verify it installs the same CLI without sudo or lifecycle scripts.
   - Fail if undocumented secrets, private packages, maintainer paths, or unpublished npm commands are required.
3. **Start the self-hosted product**
   - Run `muxr setup` in the isolated HOME; do not run a second undocumented startup command.
   - Confirm relay health, host connection, owner-only state permissions, and a visible QR plus short two-minute pairing string.
4. **Pair a fresh phone**
   - Install the exact release build on a factory-reset emulator.
   - Complete QR/pair-string consent. Confirm the app discovers or reaches only the chosen relay and reaches the Herd without email, checkout, or managed-tier UI.
5. **Control real work**
   - Create a disposable git repository and start one real Herdr agent.
   - From the app: see working/waiting/done state, open its real terminal, send input, answer a prompt, stop/restart, and confirm the phone reflects Herdr truth.
6. **Exercise public plugin parity**
   - Open Usage and Machine.
   - Browse Files as a hierarchy and open a file.
   - Review Changes with status and +/- metadata.
   - Select a non-default Runbook folder and execute there.
   - Open/download an attachment and verify its bytes/SHA.
   - Disable and re-enable a bundled plugin; create/check/install one minimal third-party plugin through documented commands.
7. **Resilience and authority**
   - Restart host and relay; verify reconnect and cumulative state recovery.
   - Interrupt a terminal and realtime synthetic stream; verify bounded reconnect.
   - Intentionally end the stream; verify it does not reconnect.
   - Revoke the emulator device and prove existing/new sockets fail while another authorized device remains valid.
8. **Notifications and Android integration**
   - Verify notification permission, working/attention lifecycle, promoted Live Update eligibility/settings behavior, launcher shortcuts, microphone foreground-service ordering, and clean stop.
   - Use a synthetic provider adapter for routine voice transport acceptance; a live paid-provider check is a separately approved release check.
9. **Uninstall and cleanup**
   - Run documented integration/daemon uninstall commands.
   - Confirm Herdr work and user repositories remain intact, muxr-owned processes stop, and no test state escapes the isolated directories.

## Evidence bundle

Record the source tag/SHA, APK/AAB SHA, environment versions, command transcript, redacted logs, device screenshots, downloaded attachment SHA, pass/fail per step, and every cleanup action. Save no QR payload, credential, provider key, internal device identifier, or private terminal output.

## Release decision

Ship only when the entire primary flow passes from the public tag and release artifacts without maintainer intervention. Documentation-only platform checks may remain clearly labeled, but setup, pairing, real agent control, plugin flows, restart, revocation, and cleanup are blockers.
