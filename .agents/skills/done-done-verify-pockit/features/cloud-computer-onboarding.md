# Start a cloud computer

The native first-run screen opens the cloud checklist. With a linked Boat account the phone creates the machine, installs and starts the muxr host on it, joins it to the person's tailnet and pairs itself with no QR, then lands on Home. Everything runs through `@byokit/cloud@0.3.0` (`apps/mobile/sources/cloud/deployBoatComputer.ts`); the installed PWA says setup must start in the muxr phone app.

## Sub-features

- `first-run-entry`: native cloud entry opens the checklist without changing link pairing or SSH routes.
- `account-link`: email starts the kit claim stream, the sign-in page and short code are shown, and a completed key is stored only in native secure storage. A stored key skips straight to size and price on the next visit.
- `size-and-price`: Small or Standard with Boat's dated per-hour price and plan floor; nothing is created before **Create cloud computer**.
- `deploy`: `machine().create` once with an idempotency key the kit saves before the create, so a retry after a lost answer gets the same computer back (a retry reuses the stored machine; a failed or gone computer is cleared, the failed one removed; leaving the screen keeps the deploy running and returning never starts a second), then `setup()` installs the published `@trymuxr/cli` as a systemd unit running `MUXR_MODE=selfhost muxr up`, joins the tailnet (a Tailscale sign-in link is shown when the machine needs one) and serves port 8792 through Tailscale Serve.
- `pair`: the setup pair gate runs `muxr self-host --configure-only --loopback --install-herdr` then `muxr pair --handoff` on the machine, reads the offer from the kit outbox, pairs over the link and delivers the two words with kit `deliver`; success lands on Home.
- `web-boundary`: PWA shows the phone-app instruction and never runs provider calls.

## How to get to it (user POV)

Open the unpaired phone app, tap **Cloud computer**, and enter the Boat account email. The sign-in action opens Boat's page; the person approves there and returns to the checklist, picks a size and taps **Create cloud computer**. If the checklist shows **Sign in to Tailscale**, approve the machine there. The PWA entry opens the phone-app instruction.

## Driving it with the private stack

Preconditions: use `../SKILL.md` isolation and its native Android + installed-PWA Visual check. Do not run `claim()` against Boat for verification; reuse the fleet's existing key and never capture the short code or a key. **Creating a machine costs money: only after the captain (through firstmate) approves the cost.**

1. On a fresh unpaired release APK, open the cloud entry and capture the checklist at 270/393 dp, font 1.0/2.0, light/dark, including scrolled end states. The link-first and SSH routes remain available and unchanged.
2. With a stored key, capture the size-and-price step the same way. Stop there unless the cost is approved.
3. Machine side without Boat: `node scripts/diagnostics/application/checkSelfhostState.mjs` proves `--configure-only --loopback` binds 127.0.0.1, serves relay health under `muxr up` and is refused by every reconfigure path; `tests/cross-side/linkPairing.integration.test.ts` covers `pair --handoff`.
4. Real run (approved cost only): Create, approve Tailscale if asked, and expect Home with the cloud computer paired. Then remove the machine from the Boat account unless told to keep it.
5. Open the same first-run route in the installed PWA; verify the cloud entry opens the phone-app instruction and no Boat request is made.

## Gotchas

- The machine installs the `CLI_SOURCE` pin in `deployBoatComputer.ts` (the npm registry tarball, sha256-checked before install); a follow-up after each release moves it (see `docs/RELEASING.md`), nothing checks it automatically. A real run needs a published CLI that has `--loopback`, `--install-herdr` and `pair --handoff`; older releases (0.2.0) fail at "Setting up muxr".
- Tailscale inside a Boat sandbox and a claimed key's create scope are unproven until a real run (BYOKit M6).
- Boat bills per second while on; the price rows are dated in `deployBoatComputer.ts` and must be rechecked against https://docs.boat.dev/pricing when they age.
