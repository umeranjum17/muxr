# Start a cloud computer

The native first-run screen opens the cloud checklist. With a linked Boat account the phone creates the machine, installs and starts the muxr host on it, joins it to the person's tailnet and pairs itself with no QR, then lands on Home. Everything runs through `@byokit/cloud@0.3.0` (`apps/mobile/sources/cloud/deployBoatComputer.ts`); the installed PWA says setup must start in the muxr phone app.

## Sub-features

- `first-run-entry`: native cloud entry opens the checklist without changing link pairing or SSH routes.
- `account-link`: email starts the kit claim stream, the sign-in page and short code are shown, **Sign in to Boat** stays tappable while the screen waits, and a completed key is stored only in native secure storage. A stored key skips straight to size and price on the next visit. A sign-in Boat has not finished after 10 minutes stops with "Boat did not finish signing in within 10 minutes. Try again." and a **Try again** button.
- `size-and-price`: Small or Standard with Boat's dated per-hour price and plan floor; nothing is created before **Create cloud computer**.
- `deploy`: `machine().create` once with an idempotency key the kit saves before the create, so a retry after a lost answer gets the same computer back (a retry reuses the stored machine; a failed or gone computer is cleared, the failed one removed; leaving the screen keeps the deploy running and returning never starts a second), then `setup()` installs the published `@trymuxr/cli` as a systemd unit running `MUXR_MODE=selfhost muxr up`, joins the tailnet and serves port 8792 through Tailscale Serve.
- `tailnet-sign-in`: the kit joins keylessly through `tailscale up`, whose sign-in link lives five minutes; the phone opens that page itself the moment the kit hands it over (once muxr is in front again if the person switched away, since Android starts no browser for a backgrounded app), so the only tap is Tailscale's own approval. **Sign in to Tailscale** stays on the step to reopen the page.
- `pair`: the setup pair gate runs `muxr self-host --configure-only --loopback --install-herdr` then `muxr pair --handoff` on the machine, reads the offer from the kit outbox, pairs over the link and delivers the two words with kit `deliver`; success lands on Home.
- `web-boundary`: PWA shows the phone-app instruction and never runs provider calls.

## How to get to it (user POV)

Open the unpaired phone app, tap **Cloud computer**, and enter the Boat account email. The sign-in action opens Boat's page; the person approves there and returns to the checklist, picks a size and taps **Create cloud computer**. When the machine needs Tailscale sign-in, its page opens by itself; approve the machine there and come back. The PWA entry opens the phone-app instruction.

## Driving it with the private stack

Preconditions: use `../SKILL.md` isolation and its native Android + installed-PWA Visual check. Do not run `claim()` against Boat for verification; reuse the fleet's existing key and never capture the short code or a key. **Creating a machine costs money: only after the captain (through firstmate) approves the cost.**

1. On a fresh unpaired release APK, open the cloud entry and capture the checklist at 270/393 dp, font 1.0/2.0, light/dark, including scrolled end states. The link-first and SSH routes remain available and unchanged.
2. Account link without Boat: start `node .agents/skills/done-done-verify-pockit/features/boatSignInLab.mjs <port>` from the repo root, build the release APK with `EXPO_PUBLIC_MUXR_BOAT_API=http://127.0.0.1:<port>/api/v1` and `adb -s $SERIAL reverse tcp:<port> tcp:<port>`. Enter `umer@example.com`, tap **Connect Boat account**, then **Sign in to Boat** while it waits: the browser shows the lab page, and back in the app step 1 reads **Connected** and size and price is next. Record it (`screenrecord`). `BOAT_LAB_APPROVE=never` keeps Boat pending for the 10-minute timeout message. The flow test `apps/mobile/sources/cloud/boatSignIn.integration.spec.ts` drives the same screen on the host.
3. With a stored key, capture the size-and-price step the same way. Stop there unless the cost is approved.
4. Machine side without Boat: `node scripts/diagnostics/application/checkSelfhostState.mjs` proves `--configure-only --loopback` binds 127.0.0.1, serves relay health under `muxr up` and is refused by every reconfigure path; `tests/cross-side/linkPairing.integration.test.ts` covers `pair --handoff`.
5. Tailscale sign-in without Boat or Tailscale: the second flow in `boatSignIn.integration.spec.ts` drives the real `setup()` against the fake Boat server with a stand-in Tailscale that waits for login, and proves the page opens with no tap, waits while muxr is in the background, and the join completes. On the emulator, the `cloud-tailnet` journey (`features/cloudTailnetLab.mjs`, under the emulator lock, with a release APK built with `EXPO_PUBLIC_MUXR_BOAT_API=http://127.0.0.1:<port>/api/v1`) runs `boatSignInLab.mjs` with `BOAT_LAB_TAILSCALE=1`, links the lab account, taps **Create cloud computer** and nothing else in muxr, and requires the browser to come up on the Tailscale sign-in page by itself, then setup to move past the join (the lab stops it at muxr's own set-up). Shots `01`–`05` and `journey.log` land in the evidence folder.
6. Real run (approved cost only): Create, approve Tailscale on the page that opens, and expect Home with the cloud computer paired. Then remove the machine from the Boat account unless told to keep it.
7. Open the same first-run route in the installed PWA; verify the cloud entry opens the phone-app instruction and no Boat request is made.

## Gotchas

- The machine installs the `CLI_TARBALL_URL` and `CLI_TARBALL_SHA256` pins in `deployBoatComputer.ts` (the npm registry tarball, sha256-checked before install); a follow-up after each release moves it (see `docs/RELEASING.md`), nothing checks it automatically. A real run needs a published CLI that has `--loopback`, `--install-herdr` and `pair --handoff`; older releases (0.2.0) fail at "Setting up muxr".
- Tailscale inside a Boat sandbox and a claimed key's create scope are unproven until a real run (BYOKit M6).
- Boat bills per second while on; the price rows are dated in `deployBoatComputer.ts` and must be rechecked against https://docs.boat.dev/pricing when they age.
- On a fresh AVD the first **Sign in to Boat** tap can leave the app showing for over 30 s while Chrome starts for the first time; tap again before calling it a failure.
