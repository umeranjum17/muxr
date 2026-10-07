# Scan a pairing QR from the computer

`muxr pair` leads with a private local QR page. It displays the running host's unchanged BYOKit offer, not a new pairing path. The terminal also prints that offer as one logical token. A half-block terminal QR is added only when both the instructions and its complete quiet zone fit.

## Sub-features

- Native offers come from the running host's owner-only pairing socket.
- The local display binds only `127.0.0.1`, on a kernel-selected port, with an unguessable path and Host validation. It serves no-store responses and closes when pairing ends.
- The local page has a single-line, selectable token and Copy button. It refreshes the same QR and token on expiry; it removes an expired code while waiting for the replacement.
- Interactive terminal offers redraw the same block rather than adding expired codes to scrollback. Plain output remains append-only.
- Setup leads with one recommended network route; alternatives are behind Other ways. App access and pairing share one stage: six stages instead of seven.

## Driving it with the private stack

Follow `../SKILL.md` Launch and Doctor. Use a task-owned tmux server, lab HOME and short TMPDIR, and a guarded non-default Herdr lab. Never resize or drive the owner's desktop. Keep the relay and fake host alive until capture completes.

1. Start the public CLI sequentially at 80×24, 91×37 and 120×40:
   `tmux new-session -d -s pair-80x24 -x 80 -y 24 'stty size; node scripts/cli.mjs pair'`.
   Inherit only the private `MUXR_HOME`, unset `NO_COLOR` and `MUXR_NO_TUI`, and record TERM and actual stty size. The running host allows only one pairing at a time: capture and cancel each before starting another.
2. Save the visible real grid (`tmux capture-pane -ep`) as ANSI and the full logical transcript (`tmux capture-pane -pJ -S -`) as text. The local-page URL must fit on one line at all three grids, and the transcript must contain exactly one complete `byokit-link:` token without hard line breaks.
3. Open the URL printed by that CLI on this computer. Save a browser PNG showing the whole QR and single-line token field; also capture the viewport to verify the QR's quiet zone is not clipped. Decode with `zbarimg --quiet --raw <png>`. Compare decoded bytes with the logical terminal token and the page's `/offer` response. Validate with the same `parseOffer` from `@byokit/link` that the native phone uses. Do not scan the loopback display URL on the phone: scan the QR on that page.
4. Leave one CLI running for the actual two-minute offer expiry. Save terminal grid, logical transcript, tmux history_size and the local page before and after. The offer must change, the page URL must stay the same, and the transcript must still contain only one offer with no history growth. The page QR and Copy token must follow the new offer without navigation. Retain both decoded values. Record the interaction with `record start/stop` if available, otherwise retain timestamped before/after captures and disclose that limitation.
5. Capture before/after terminal PNGs at all three grids. ANSI-to-PNG rendering is acceptable when desktop screenshots are unsafe: retain ANSI and dimensions, preserve SGR colors, disclose rendering, and inspect every PNG.
6. Cancel only this CLI, verify the loopback page has stopped listening, and then capture the next grid. Check plain/non-TTY output retains the exact token without escape sequences.
7. Run the existing real link pairing integration journey (`npx vitest run tests/cross-side/linkPairing.integration.test.ts`) to prove a phone claims the offer shown by the local page, compares the words, persists its grant, and reaches the machine. That journey also proves Host rejection and page cleanup. Run the existing wizard selfcheck to verify Other ways preserves alternative routes and cancellation, and record the six setup stages from its completed flow.

## Gotchas

- Detached tmux windows keep their requested grid; attachment may resize them.
- A 302-character offer needs a 77-column, 39-row half-block QR. Its instructions do not fit alongside it at 120×40 either; the scannable local page is intentional, not a truncated terminal QR.
- Terminal soft wraps are not token separators: select the logical line or capture with `-J`. The page's input and Copy button avoid wrapping entirely.
- Plain/dumb output cannot redraw. Do not claim an append-only stream refreshes in place.
- Keep offers and captures private; never commit them. Cleanup must preserve evidence.
