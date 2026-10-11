# Read the desktop receiver's decoder and frame rate (developer probe)

With developer mode on, the active machine screen offers one extra row,
**Desktop decoder**. Opening it starts a live desktop session and shows what the
receiver's own `getStats()` reports — the decoder implementation, codec, picture
size, frames per second, and the decoded/dropped/packets-lost counters — so a
build can name the actual hardware decoder (iOS reports `VideoToolbox`), not an
assumption. Neither the row nor the route exists until developer mode is on.

## Sub-features

- `probe-gate-off` with developer mode off, the machine screen shows no
  `Desktop decoder` row; the route `/debug/decode` redirects Home.
- `probe-gate-on` after ten taps on **Installed app** (Connection & updates),
  the active machine screen shows the row and it opens the probe.
- `probe-live` the probe streams the remote desktop and, once packets arrive,
  reads decoder, codec, picture size, fps and the frame counters, refreshing
  about once a second with the counters climbing.

## How to get to it (user POV)

- Pair the phone to a computer with a desktop session.
- Settings → **Connection & updates** → tap **Installed app** ten times; an
  alert confirms developer mode is on.
- Settings → **MACHINES** → the active machine → **Desktop decoder**.

## Driving it with the private stack

Preconditions:

- A private muxr stack (`../SKILL.md` Launch) whose host runs on `--fake` with a
  live desktop source (`MUXR_DESKTOP_SOURCE=x11` on a loopback X display whose
  root window keeps changing), paired to the viewer.
- A native viewer: an iOS Simulator you created, on the Mac slot.

- **Gate off.** On the machine screen dump the accessibility tree (`axe
  describe-ui --udid <udid>`); no `Desktop decoder` label is present, and the
  content ends at `Last Seen`.
- **Gate on.** Tap **Installed app** ten times in a burst (the toggle resets
  after 2 s idle); the `Developer Mode` alert appears. Return to the machine
  screen and the `Desktop decoder` row is present.
- **Live read.** Open the row. When the desktop is streaming, the readout shows
  `Decoder VideoToolbox`, `Codec video/H264`, a `Picture size`, a non-zero
  `Frames per second`, and `Frames decoded` rising between two reads while
  `Frames dropped` stays at 0.

## Gotchas

- The probe reports what the receiver decodes, so it must be streaming; with no
  packets it shows the absent reading, not a zero.
- The dev-mode toggle is the same ten-tap used elsewhere; a slow tap cadence
  resets the counter and never fires.
- The iOS Simulator decodes with the Mac's `VideoToolbox`; this proves the
  hardware path the receiver selects, not device-specific throughput.
