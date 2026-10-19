# Set up a computer in one screen

A first run of `muxr` reviews its plan on the route screen: step 2 of 3
shows the recommended route (Tailscale, your own tailnet) preselected, `Other ways` under it, and the short
plan under both. One Enter on a route applies it; there is no separate
`Review setup` screen or `Apply this setup?` question. A later run that
changes an existing setup keeps its extra questions and the final review.

## Sub-features

- `tailscale-default` with Tailscale connected, the route is `Use muxr away
  from home (Tailscale) · Recommended`, even when Wi-Fi, a private network or
  cloudflared is present.
- `missing` with no Tailscale, step 2 offers `Check again` and `Other ways`
  under one sentence: `Tailscale isn't on this computer yet. Install it from
  https://tailscale.com/download and sign in, then press Enter to check
  again.` Install and sign in, press Enter: step 2 redraws with Tailscale
  recommended, and one more Enter applies. Installed but not running reads
  `Tailscale is on this computer but not connected: <how to start it>, …`.
- `signed-out` installed and signed out (`NeedsLogin`): Tailscale stays
  recommended with `Sign-in happens next`; Enter runs `sudo tailscale up` (the
  macOS app on a Mac) before the install.
- `no-wifi` a new setup lists `Works only on this Wi-Fi` behind `Other ways`
  only on a plain computer (no Tailscale connected or planned, no private
  network, no usable cloudflared, no relay enrollment); any other new setup
  never lists it, and a computer already on it keeps it there as `· current`.
- `one-enter` step 2 of 3 reads `How will your phone reach this computer?`
  with the plan under the routes (Herdr line, pairing, browser later, `Press
  Enter to apply this setup. Nothing changes before then.`); Enter goes
  straight to step 3 `Install, start, and pair`.
- `other-ways` `Other ways` redraws step 2 with the whole route list and the
  same plan; Enter on a route there applies it, and esc goes back to the
  route screen (and its `Check again`).
- `cancel` esc on the route screen prints `Cancelled. Nothing changed.` and
  writes no `~/.muxr/selfhost.json`.
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

For the Tailscale states, point `MUXR_TAILSCALE_BIN` at a lab stub script
that prints `tailscale status --json` from a state file (`missing` exits as
not found, `NeedsLogin`, or `Running` with `Self.TailscaleIPs` and a
`DNSName`) and answers `serve status --json` with `{}`. Flip the state file
between screens to play install and sign-in. For `signed-out`, put a lab-only
`sudo` shim first on `PATH` inside the bwrap that runs its arguments, so
`tailscale up` reaches the stub. Never the real `tailscaled`.

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
