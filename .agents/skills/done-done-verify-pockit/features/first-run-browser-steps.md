# First-run link-first shell

An unpaired native app and installed PWA open on three steps: **Get
Tailscale**, **Get muxr on your computer** (native: **Get the desktop app**,
which opens Add your computer; PWA: a pointer to the command under More ways),
then **Pair with your computer**, with a private-link/code field and
**Connect**. Native also offers
**Scan the QR** where the scanner is available, **SSH login** where the
existing SSH transport is available, and an active **Cloud computer** entry.
That entry opens the cloud checklist on native and a phone-app instruction on
PWA. **More ways & timing** reveals the existing computer setup card
and optional HTTPS, tunnel, Tailscale and local-network routes.

## Sub-features

- `steps-order`: Tailscale, then muxr on the computer, then the pair field and
  Connect, all on one screen; nothing must be tapped before the field is usable.
- `existing-consent`: Connect and keyboard Go use the same `useHostedPairing`
  validator and `/pair` consent route as Scan. There is no automatic claim,
  grant storage or second consent flow in the shell.
- `ssh-entry`: native SSH login opens `/pair?route=ssh`, unchanged. The browser
  has no SSH transport and does not offer an actionable SSH entry.
- `cloud-entry`: Cloud computer is an active native entry to the checklist;
  PWA directs setup to the muxr phone app.
- `setup-details`: More ways reveals the existing copyable command and its
  effects disclosure.

## Driving it

Follow `../SKILL.md` isolation and **Visual check** on main and candidate:
release APK on a task-owned emulator and installed PWA with a private profile,
393/270 dp, font 1.0/2.0, light/dark, including end-of-scroll captures. Build
from the candidate, verify the APK provenance and served web chunk before
capturing, and confirm PWA `display-mode: standalone`. Capture with
`visualCheck.mjs` (native) and its PWA DOM leads; inspect every shot.

1. Open with no stored grant. Steps 1 and 2 lead, then the pair card. Ensure
   the steps, field, Connect, alternatives and footer wrap without overlap at
   the narrow/largest-text extremes; there a step drops its number badge and
   its title carries the number ("1. Get Tailscale") instead.
2. Tap Cloud computer: native opens the cloud checklist; PWA shows the phone-app
   instruction. Do not start a Boat claim. Tap native SSH login: the existing SSH
   form opens. Return to the shell.
3. Expand More ways & timing, scroll to the end, and capture the command,
   effects disclosure and optional routes. At the narrow/largest-text extreme,
   the command card stacks its text and Copy instead of squeezing them beside
   a step-number badge. Open **What running this does** too; its text must
   wrap inside the control, not run over the following content. Copy must
   retain the exact command
   ([first-run-install-command.md](./first-run-install-command.md)).
4. With the private stack and pair socket described in
   [pairing-consent.md](./pairing-consent.md), obtain a fresh offer for the
   actual device kind (native or browser). Paste it into the shell and press
   Connect (also exercise Go). Record **link → existing consent**; the
   screen states the machine, authority and duration before any claim.
   Do not publish the offer or grant in logs or evidence. Stop at consent
   unless the lab journey explicitly includes approval. Use trusted keyboard
   input if a browser fill changes the DOM value without updating React state.
   For a sampled PWA clip, capture real viewport frames through the same
   screenshot command used for the matrix, retain actual timestamps, and
   redact the input using the captured pixel width / CSS viewport width (not
   an assumed DPR). Check the first and consent frames plus decoded dimensions;
   a raw CDP full-window or blank capture is not this proof. Label sampling
   honestly; it does not qualify animation frame rate.
5. A wrong/cut-off link shows the existing useful validator error and never
   claims a grant. Scan, where available, uses the same consent route.

## Proof

Save before/after PNGs under `$EVIDENCE/visual/<native|pwa>/<main|candidate>/`
using the Visual check's `<screen>-<width>-<font>-<theme>[-scrolled].png`
names, plus a short `link-to-consent.mp4`, SSH entry and expanded-details
captures. Record commands, candidate/APK/web identities, visual lead verdicts
and cleanup in the evidence log. Put absolute paths and limitations in the
PR's `## Checks`. A build or component spec alone is not this proof.

The existing FirstRunConnection spec exercises the shell through the real
pairing-input validator; [pair-scan-first.md](./pair-scan-first.md) owns
subsequent pairing-page scan, expiry and paste recovery behavior.
