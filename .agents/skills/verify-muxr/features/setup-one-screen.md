# Set up a computer in one screen

A first run of `muxr` reviews its plan on the route screen: step 2 of 3
shows the recommended route preselected, `Other ways` under it, and the short
plan under both. One Enter on a route applies it; there is no separate
`Review setup` screen or `Apply this setup?` question. A later run that
changes an existing setup keeps its extra questions and the final review.

## Sub-features

- `one-enter` step 2 of 3 reads `How will your phone reach this computer?`
  with the plan under the routes (Herdr line, pairing, browser later, `Press
  Enter to apply this setup. Nothing changes before then.`); Enter goes
  straight to step 3 `Install, start, and pair`.
- `other-ways` `Other ways` redraws step 2 with the whole route list and the
  same plan; Enter on a route there applies it.
- `cancel` esc on either list prints `Cancelled. Nothing changed.` and writes
  no `~/.muxr/selfhost.json`.
- `wrap` at 80 columns route descriptions and notes wrap at spaces under their
  indent, never mid-word.
- `requested-mode` `muxr setup --mode <route>` on a first run skips the picker,
  so it still shows the plan and `Apply this setup?`.

## How to get to it (user POV)

- Computer with no muxr state: run `muxr` -> step 2 -> Enter -> QR.

## Driving it with the private stack

Preconditions: the lab of [dial-out-relay](./dial-out-relay.md) (relay on
`MUXR_RELAY_PORT=0`, a fresh enrollment per run, the computer side in
`bwrap --unshare-net` so the inspection shows no real network, Herdr lab
session behind `HERDR_BIN`, a host loop standing in for the service manager)
plus `MUXR_TAILSCALE_BIN` pointing at a missing file, a fresh `HOME` per run,
and a private tmux server from `fm-lab-home.sh tmux-dir`.

- **Time it.** One tmux session per run at `-x 80 -y 42` and `-x 120 -y 42`
  (fullscreen needs 80x40). Poll `tmux capture-pane -e -p` every 0.1 s into
  timestamped frames, wait for the route question, pause a fixed reading time
  (5 s), send Enter, and log when `Install, start, and pair` and the pairing
  code appear. For the base commit, also wait for `Apply this setup?`, pause,
  and send Enter. Route screen -> apply started is what this feature changes;
  apply itself varies with how fast the lab host starts.
- **Capture.** Render the route frame, the `Other ways` list and the cancel
  screen to PNG (ANSI -> HTML -> `chromium --headless --screenshot`), and the
  frames to an mp4 with their real durations. Redact the pairing string.

## Gotchas

- The relay allows 10 enrollment requests a minute per address; each run
  mints and claims about four. Leave 65 s between runs or the claim fails with
  `too many requests`.
- `fm-herdr-lab.sh` keys its state off `TMPDIR`. A `HERDR_BIN` wrapper run
  from an `env -i` shell must set the same `TMPDIR` the lab was provisioned
  with, or it finds no lab session and the host refuses to start.
- In the alternate screen, the QR pushes `connected this machine to` off the
  visible rows at 80 columns; also accept `Waiting for the device to finish
  pairing` as the applied marker.
