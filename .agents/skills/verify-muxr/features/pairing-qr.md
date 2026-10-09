# Scan a pairing QR from the terminal

`muxr pair` prints a centered QR when one fits the terminal with its quiet zone, then the instructions and the unwrapped pairing string, which the terminal may soft-wrap but never splits. The host mints both the full v1 offer and the compact offer; the QR and the string are always the same offer: the full v1 where both fit (only it resumes through the kit's pendingGrant when the phone dies before approval), otherwise the compact offer at the full quiet zone, then at a two-module quiet zone. Where no QR fits (80x24), the compact string prints followed by one line, `Open the QR page: <url>`, that opens a local page on this computer carrying the same token as a scannable QR. Plain output prints the full string with no QR.

## Sub-features

- Native pairing offers use the running host's private pairing socket and existing BYOKit link.
- The printed token is the offer the QR carries: the full string where the full QR fits, the compact string where only it fits. Either scans and pairs; a phone killed before approving a compact offer rescans. The string always prints.
- Interactive offers draw on the terminal's alternate screen from the top and redraw there on each refresh and resize, so expired codes never reach scrollback. The QR comes first and stays whole; the recommended route leads, and the text lines below it are kept in priority order only while the rows left over hold them. Plain output remains append-only.
- Setup leads with one recommended network route; alternatives are behind Other ways. A first run is four steps; a repeat run is six.
- After verified pairing, a computer without `WAYLAND_DISPLAY` or `DISPLAY` skips screen-sharing approval with one plain line and exits 0.
- Caught screen-sharing failures preserve the real reason and say pairing is done only after verified pairing. Fatal CLI exceptions/rejections print one plain line and exit 1; `MUXR_DEBUG=1` enables their stack.
- A QR needs its matrix width and half-block row count. The offer view prints the QR first and the text after it, with no trailing newline, so the text takes only the rows left over; `printTerminalQr` (setup) keeps one cursor row below.
- Row priority in the offer view: QR, then the string, then the QR-page line (only when no QR fits), then title, expiry, compare and waiting lines, then the "Other ways" label, each while the rows hold them. The QR and string are reserved first, so the string never drops. The QR-page line is one row at 80 columns and always printed.
- The local QR page (`scripts/setup/infrastructure/pairingPage.mjs`) starts only when an interactive native offer has no QR that fits the terminal, serves on loopback with a random path and a Host check, and refreshes with each offer. Its QR is shown only when the terminal cannot fit one, so the page line appears only where no QR fits (80x24 and smaller); 91x37 and 120x40 keep the in-place QR. Setup's `printTerminalQr` prints an omission reason instead.
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
6. At 80x24 the QR is omitted with the one-line QR-page URL: open it in a browser on this computer, decode its QR with `zbarimg` against the printed string, and confirm one refresh keeps the same URL and shows the new token. Check the exact width boundary and one row below the required height with the same public CLI. Below the required height the QR is omitted with a reason, and the complete pairing string stays on screen. Capture 80x24, 91x37 and 120x40 both before and after one refresh (a refresh must leave one block on screen and nothing in scrollback).

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

## Headless pairing and CLI failures

Use the native Android app on a task-owned emulator with the private stack; start
the relay/host before taking its device lock. For loopback relay fixtures, reverse
only the owned relay port with `adb -s <owned-serial> reverse tcp:<port> tcp:<port>`.

1. Run `env -u WAYLAND_DISPLAY -u DISPLAY node scripts/cli.mjs pair` in the
   private terminal. Open the offer in the native app, compare the words and
   approve on the computer. Save the emulator's paired view and terminal output.
   Expect verified pairing followed by
   `Screen-sharing approval skipped: no display on this computer.`, exit 0.
   Confirm enrollment with `node scripts/cli.mjs devices list`.
2. Stop only the lab host, keeping its relay alive. Run the same public pairing
   command with `MUXR_PAIR_SOCKET_WAIT_MS=0`. Expect exit 1 and one line naming
   `muxr daemon start` and `muxr pair`; no Node stack. Restart only the lab host
   if more proof remains.
3. For the CLI fatal boundary, import `scripts/cli.mjs` with argv `--version`,
   then use the real published `EngineClient` and a real Node child with piped
   stdio. End `child.stdin` and call `client.request('hello', {})` inside an
   async try/catch. This forces the kit's unhandled Socket error, not a mocked
   Promise rejection. Keep stdout identity separate from stderr: expect exit 1
   and exactly one stderr line carrying `write after end`. Repeat with
   `MUXR_DEBUG=1`: exit 1 with the diagnostic stack. Never patch the kit or resume
   execution after a fatal event.
4. Exercise a rejected Promise after the same CLI import: expect one plain
   stderr line and exit 1. Also run `env -u WAYLAND_DISPLAY -u DISPLAY node
   scripts/cli.mjs desktop setup`: the headless skip exits 0 even when approval
   was explicitly requested.

The forced kit case proves fatal CLI containment, not recovery or successful
pairing. A scoped lab cannot exercise installation of the real background
service: retain that limitation rather than touching the owner's service.

## Gotchas

- Terminal attachment can resize a tmux window. Keep proof sessions detached or use manual window sizing, and record the actual `stty size`.
- BYOKit's half-block renderer trims trailing spaces. muxr restores the matrix width, including its quiet zone (four modules, or two where only the compact offer fits); do not infer width from the longest trimmed line.
- Text printed below the QR must leave its rows free: a wrapped token or instruction that pushes past the bottom scrolls the offer's top off the screen.
- Offers expire and are private: keep captures in private evidence storage, never commit them. Cancel the offer after capture; this proof does not approve or pair a device.
