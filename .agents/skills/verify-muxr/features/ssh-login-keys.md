# Sign in over SSH with an Ed25519 key

Android accepts a cloud machine's Ed25519 login key through the existing Direct SSH form, without replacing pairing consent or the device grant. RSA remains usable. iOS uses the same form with libssh2/OpenSSL; the PWA offers no native SSH route.

## Sub-features

- An OpenSSH Ed25519 private key signs in and carries pairing through the tunnel.
- An RSA private key still signs in through the same validator and native module; adding Ed25519 does not displace the RSA/ECDSA host-key preference behind existing pins.
- A rejected key reports a credential failure, not a claim that Ed25519 is unsupported.
- Connection settings can show an Ed25519 fingerprint without an unsupported-key warning. Public-key installation retains its separate RSA/ECDSA restriction.

## How to get to it (user POV)

On an unpaired native app, choose **Connect over SSH**. Enter the host, username, SSH and relay ports, and private key. Paste the machine's pairing string, review the existing consent, and connect. Once paired, open Settings > Connection & updates to read the connected Direct SSH route and key fingerprint.

## Driving it with the private stack

Preconditions: the Launch recipe's private fake host and relay, a release APK built with `perf/buildPrApk.mjs`, Docker, and a task-owned Android emulator. Never use an existing SSH server or a person's keys. Start long jobs in owned shell panes and clean them up by exact PID/container name.

1. Generate test-only keys outside the checkout, with an empty passphrase:
   `ssh-keygen -q -t ed25519 -N '' -C 'Umer SSH lab' -f "$RUN_ROOT/login-ed25519"` and an equivalent RSA key with `-t rsa`. Generate a separate RSA host key. Put only the two public login keys in the fixture's `authorized_keys`.
2. Run OpenSSH in a uniquely named task container. On Linux, `--network host` lets its forwarding target reach the Launch recipe's **owned** loopback relay. Use an unused task SSH port; `ListenAddress 127.0.0.1`, the generated `HostKey`, the fixture `AuthorizedKeysFile`, `StrictModes no`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `UsePAM no`, `AllowUsers Umer`, `AllowTcpForwarding local`, `PermitOpen 127.0.0.1:<owned-relay-port>`, and `LogLevel VERBOSE`. Create/unlock only the container's fixture user `Umer`. Do not alter host sshd or mount a person's SSH directory.
3. Admit an emulator through the fleet memory gate and use `adb -s "$SERIAL"` for every action. Reverse just the task SSH port: `adb -s "$SERIAL" reverse tcp:<ssh-port> tcp:<ssh-port>`. The form's SSH host is `127.0.0.1`; its relay port is the owned relay port, as seen from the container.
4. Install the release APK on that emulator. Drive the ordinary first-run SSH form with the generated Ed25519 private key and a fresh native pairing offer from the Launch recipe's host. Use the existing phone/host consent; never fabricate a grant or populate connection settings yourself.
5. Read the result independently: the container log must say `Accepted publickey for Umer` with `ED25519` and the generated public key's fingerprint; the phone must show pairing completed and a connected Direct SSH route. Reconnect once to exercise the saved credential. Do not publish pairing offers or private-key fields as evidence.
6. Repeat with RSA from a fresh fixture pairing, and require an `RSA` acceptance in the container log and a connected route. Also advertise both generated RSA and Ed25519 host keys: the existing RSA pin must still work for either login key. Test an unregistered generated key too: authentication fails and no pairing is reported complete.
7. Run the skill's Visual check for the SSH result and changed fingerprint/help text at 393/270 dp, light/dark, font 1.0/2.0 and scrolled-to-end where applicable. Review every captured image. Since web has no SSH module, verify the installed PWA still omits this route; never substitute a web screen for the native login proof.
8. Keep APK/source identity, public fingerprints, red/green command logs, acceptance logs, route-result PNG/XML and screenshot review notes in the stable evidence folder. Remove the task adb reverse, stop the emulator with `adb -s "$SERIAL" emu kill`, stop/remove only the task container, and stop the owned relay/host before deleting scratch keys and state.

## Gotchas

- Removing a string-based Ed25519 rejection alone is insufficient. SSHJ parses a base64 OpenSSH key with JCA and selects signature algorithms from its config; both parsing/signing and the configured algorithm must support Ed25519.
- Android's platform `BC` provider shadows the bundled jar. The SSH-owned provider must not remove or replace platform BC. Desktop Java success is supplementary, never Android proof.
- Private-key inputs contain newlines. When driving with adb line-by-line, verify focus and use `</dev/null` inside read loops so adb cannot consume the remaining input.
- The installed APK must contain this candidate's native module; Fast Refresh cannot change Kotlin.
- Public-key installation is a different operation from login and remains guarded by its existing supported-algorithm and confirmed-account checks.
