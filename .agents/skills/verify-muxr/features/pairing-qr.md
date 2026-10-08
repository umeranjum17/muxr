# Scan a pairing QR from the terminal

`muxr pair` prints the full BYOKit pairing string and instructions, then a centered QR when its complete quiet zone fits the terminal. Small or plain terminals retain the exact string instead.

## Sub-features

- Native pairing offers use the running host's private pairing socket and existing BYOKit link.
- A QR needs its matrix width and half-block row count plus one cursor row, not spare rows for instructions already printed above it.
- Narrow or short terminals print an omission reason and the complete pairing string.
- At the approval prompt, Enter re-asks without rejecting the device; `y` approves and `n` declines.
- A non-TTY `muxr pair` (AI agent or script) never approves: it prints exactly one line — `Pairing needs you at this computer's terminal: run `muxr pair` yourself` — and exits 2. The person must run `muxr pair` at the terminal.

## How to get to it (user POV)

Run `muxr pair` on the computer running muxr. Scan the QR in the native app, or use the exact pairing string above the omission message. Compare the two words before approving.

## Driving it with the private stack

Preconditions: follow `../SKILL.md` Launch and Doctor. Use only a task-owned tmux server and a guarded non-default Herdr lab. Keep the relay/host alive until all terminal captures finish. Do not resize or drive the owner's desktop.

1. In the private tmux server, start the public CLI in a 100-column, 40-row terminal:
   `tmux new-session -d -s pair-normal -x 100 -y 40 'node scripts/cli.mjs pair'`.
   Inherit the private `MUXR_HOME`, unset `NO_COLOR` and `MUXR_NO_TUI`, and record `TERM`, locale and `stty size` in the terminal before the command.
2. Capture the visible grid with `tmux capture-pane -ep -t pair-normal`, and the complete unwrapped transcript with `tmux capture-pane -pJ -S - -t pair-normal`. Save both outside scratch. Cancel only this pane's command before starting another offer.
3. Repeat at 40 columns × 20 rows: the QR must be omitted with the measured terminal size, while the unwrapped transcript contains the full `byokit-link:` string on one line.
4. Repeat inside a pane of the guarded Herdr lab. Drive every Herdr command through that lab's helper, including `pane run`, `pane read --source visible --ansi`, and cancellation. Record the pane's actual terminal grid; do not assume its initial dimensions.
5. Save before/after PNGs for all three terminals. An ANSI-to-PNG rendering of the captured real grid is acceptable when desktop screenshots are unsafe; disclose that it is a rendering, retain the source ANSI and dimensions, and preserve foreground/background SGR colors (including Herdr's indexed colors). Inspect every PNG. Decode successful QR captures with `zbarimg --quiet --raw <png>` and compare the decoded text with the offer in the full transcript.
6. Check the exact width boundary and one row below the required height with the same public CLI. At insufficient width or height, the fallback must retain the complete string, never a wrapped QR.

## Approval prompt

For a terminal-only approval change, run:

```sh
npx vitest run tests/cross-side/linkPairing.integration.test.ts -t 'keeps pairing open after Enter'
```

This starts a private real relay and fake-session host (no Herdr access), then
runs `pairOnRunningHost` with its default approval prompt in a real PTY.
The real phone pairing modules claim the offer and finish the enrollment.
Enter must print the question a second time without completing pairing;
`y` must then finish on both sides and leave the device enrolled.
To disprove the check, remove `reaskOnEmpty` from `showApproval`: it must fail
waiting for the second question. Restore the candidate before continuing.

For manual proof, use `muxr pair` on the private stack, claim its offer, and
capture the terminal before and after Enter, then `y` (or `n` to cancel).
Retain the real PTY transcript and before/after prompt views outside scratch.
ANSI-to-PNG prompt renderings are acceptable with the source retained and the
rendering disclosed; inspect both images. The PTY flow checks the shared
pairing producer, not CLI setup or desktop screen-sharing after pairing.
No emulator turn is needed when only the terminal prompt changes.

## Non-TTY guard

When the pairing approval is unreachable (no TTY), prove it exits instead of
looping re-mints:

```sh
time node scripts/cli.mjs pair </dev/null | cat; echo "exit=$?"
```

The output must be exactly `Pairing needs you at this computer's terminal: run
`muxr pair` yourself`, exit 2, under 1 s, and the host log must show no pairing
offer was minted. `muxr setup` converges on the same `mintDeviceGrant` call, but
a task-owned (scoped) `MUXR_HOME` cannot prove its full path: the daemon
registration refuses before pairing — expected scope-guard behavior, not a bug.
To disprove the check, delete the non-TTY guard at the top of the `linkPair` loop:
the command then stays at the approval prompt or loops re-minting offers. Restore
the candidate before continuing.

## Gotchas

- Terminal attachment can resize a tmux window. Keep proof sessions detached or use manual window sizing, and record the actual `stty size`.
- BYOKit's half-block renderer trims trailing spaces. muxr restores the matrix width, including its four-module quiet zone; do not infer width from the longest trimmed line.
- Print text before the QR so wrapping instructions or a long pairing string cannot scroll its quiet zone away. The final newline still consumes one cursor row.
- Offers expire and are private: keep captures in private evidence storage, never commit them. Cancel the offer after capture; this proof does not approve or pair a device.
