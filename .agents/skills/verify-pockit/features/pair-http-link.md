# Paste an http pairing link

A computer advertising its relay over plain `ws://` (a LAN self-host, or a lab
relay) prints its browser pairing link as
`http://<relay>/pair#byokit-link:1:…` — `scripts/setup/application/linkPair.mjs`
builds the base from `webOrigin ?? relayUrl with ws→http`, and `webOrigin`
exists only when `--web` (HTTPS) is on. The paste path (`decidePairingInput` →
`pairingTermsFromInput`) accepts that wrapper like the https one: the offer
rides in the fragment, the offer's own ws:// addresses are what a phone dials,
and the web platform keeps its https-wrapper guard
(`assertSupportedOffer` → `isBrowserLinkOffer`) untouched. A token truncated
mid-base64 is still "cut off".

## How to prove it

1. Start the verify-pockit stack (relay on `MUXR_RELAY_PORT=0`, selfhost.json
   with `relayUrl: ws://127.0.0.1:<port>` and no `webOrigin`, host `--fake`).
2. Open a browser-intent offer through the real pairing client (what
   `muxr pair --browser` drives): the offer text must be
   `http://127.0.0.1:<relay port>/pair#byokit-link:1:…`.
3. Serve a web export (`serveWebExport.mjs`), open it in a standalone Chromium
   window (`--app=`, `display-mode: standalone` true), type the link into
   "Private link or pairing code", tap Connect: the consent screen
   ("<machine> wants to pair with this browser") appears — not "This string is
   cut off". On web, confirming Pair then names the https-wrapper web rule
   ("Native pairing codes are for phones…"), unchanged.
4. Truncate the token's tail (8 chars off the base64) and repeat: Connect
   names "Pairing code not usable — This string is cut off."

2026-10-17 run (rd-pair-http-link): before (main parser) and after captures in
the PR evidence; consent shots pass `pwa-check` clean in light and dark at
270x594; the before cell's only lead is the modal covering Connect, which is
the alert doing its job.
