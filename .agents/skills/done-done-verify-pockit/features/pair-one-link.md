# Pair a phone from one link (`muxr link`)

On a tailnet route (the advertised relay is a `*.ts.net` name or a
100.64.0.0/10 address) each computer has one stable, secret pairing link:
`http://<tailnet address>:<relay port>/join#<43-char secret>`. `muxr link`
prints it and its QR (`muxr setup` and plain `muxr pair` show the same thing).
`--new` replaces it. Off a tailnet it says so and points at `muxr pair --code`.

- The secret is `machine.crypto.pairLink` in `selfhost.json`. It survives host
  and relay restarts. Revoking a device or rotating keys drops it, so a revoked
  phone's copy stops pairing (`scripts/setup/application/revokeDevice.mjs`).
- `GET /join` on the relay serves a static page
  (`apps/relay/src/admission/infrastructure/pairLink.ts`). It has Open in muxr
  (`muxr://join?to=<link>`), Open in muxr Preview, and the install steps. The
  secret stays in the fragment, so a GET never sends it.
- `POST /join {secret}` hands the secret to the host over the owner-only
  `pair.sock`. The host checks it in constant time
  (`scripts/setup/application/linkPair.mjs` `pairLinkMatches`), opens one
  native control pairing that needs no approval, and returns its offer.
- The app accepts the link pasted (first screen **Paste a link** reads the
  clipboard) or opened (`muxr://join?to=…` through `+native-intent.ts`). It
  shows the consent screen and redeems the link only when Pair is tapped. The
  PWA refuses the link with "This link pairs the muxr phone app…".

## Sub-features

- `link-cli` `muxr link` prints the same link on every call and after a
  restart; `--new` prints a different one; a loopback or LAN relay errors with
  "…is not a tailnet, so it has no pairing link".
- `install-page` the link opened in a browser with no muxr app shows the page;
  a link with no `#…` shows the cut-off note.
- `one-tap` the installed app opened on the link, or with the link pasted,
  reaches Home after one Pair tap. There is no code to type and no approval
  step on the computer.
- `revoked-link` after `muxr devices revoke`, the old link is refused with
  "This pairing link no longer works…".

## Driving it

Flow test: `tests/cross-side/pairedDevices.integration.test.ts` (it pairs with
the link, checks the link survives a restart, and checks it dies on revoke).

Live, with the Launch stack, change two things:

1. Start the relay with `MUXR_RELAY_HOST=<tailscale ip -4>`. Put its data dir
   at `$MUXR_HOME/relay`, so its default `pair.sock` path
   (`$MUXR_HOME/host/pair.sock`) is the host's (or set `MUXR_PAIR_SOCKET`).
2. In `selfhost.json`, set `relayUrl: ws://<tailscale ip>:<port>`.

Then `MUXR_HOME=… node scripts/cli.mjs link`. An emulator reaches the
desktop's own tailnet address through its NAT, so a release APK on a
task-owned AVD can be driven with
`am start -n com.trymuxr.app/.MainActivity -a android.intent.action.VIEW -d 'muxr://join?to=<encoded link>'`
(always give the explicit component). Capture the consent screen, tap Pair, then
capture Home. `pairOneLinkLab.mjs` (beside this file) drives the whole native
journey on its own AVD: install page in Chrome before install, first screen
and consent at 270/411 dp in both themes, Open in muxr → one Pair tap → Home,
revoke → old link refused, new link pairs. The lab host is `--fake` with no
agents, so Home is proven by `connected`, not an agent card. Open the link itself in Chromium (`chrome-devtools-axi`) at phone
and desktop widths, light and dark, to capture the install page.
