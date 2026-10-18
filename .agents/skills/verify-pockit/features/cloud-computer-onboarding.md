# Start a cloud computer

The native first-run screen opens the cloud checklist and Boat account-link step. The account-link step uses `@byokit/cloud@0.1.0` and stores a returned key in native secure storage; the installed PWA says setup must start in the muxr phone app. This first journey slice ends after account connection; it does not create a machine.

## Sub-features

- `first-run-entry`: native cloud entry opens the checklist without changing link pairing or SSH routes.
- `account-link`: email starts the kit claim stream, the sign-in page and short code are shown, and a completed key is stored only in native secure storage.
- `web-boundary`: PWA shows the phone-app instruction and never runs provider calls.

## How to get to it (user POV)

Open the unpaired phone app, tap **Cloud computer**, and enter the Boat account email. The sign-in action opens Boat's page; the person approves there and returns to the checklist. The PWA entry opens the phone-app instruction.

## Driving it with the private stack

Preconditions: use `../SKILL.md` isolation and its native Android + installed-PWA Visual check. No relay, host, or Herdr session is needed to inspect this slice. Do not run `claim()` against Boat for verification; the current task uses the fleet's existing key and forbids another claim. Never capture the short code or a key.

1. On a fresh unpaired release APK, open the cloud entry and capture the checklist at 270/393 dp, font 1.0/2.0, light/dark, including scrolled end states. The link-first and SSH routes remain available and unchanged.
2. Open the same first-run route in the installed PWA; verify the cloud entry opens the phone-app instruction and no Boat request is made.
3. Compare the checklist with the approved B mock. Inspect every capture; no email, sign-in code, token, pairing string, or personal data may be retained.

## Gotchas

- Boat account-link is a live external sign-in and is intentionally not repeated in this proof. Account completion and all later machine steps require a subsequent slice's real-provider proof.
- This slice does not create, join, install, pair, or show the Home machine card. Do not report those behaviors as verified.
