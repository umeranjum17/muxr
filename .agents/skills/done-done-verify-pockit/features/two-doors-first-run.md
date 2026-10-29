# Two doors to a working agent terminal

An unpaired app opens on **Connect a machine** with two equal doors: **My
computer** (pair the machine you already have; about 4–5 min, about 1 min if
muxr already runs; needs Tailscale on both ends) and **Cloud machine · Boat**
(a Boat server muxr sets up and pairs; about 4–6 min with a Boat account; paid
to Boat, from the cheapest size's hourly price in `deployBoatComputer.ts`).
Direct SSH stays a small link under the doors on native builds that carry the
transport. A browser reaches the doors from the demo's **Connect a machine**
(`/connect`); there the Boat door says to set up from the phone app.

Each door is a three-step branch and every step screen shows its own time:

- My computer (`/my-computer`): 1 Get ready (Tailscale on both ends, muxr on
  the computer), 2 Pair with your computer (Scan the QR where the device can
  scan, Private link or pairing code, then two example words to compare),
  3 Start an agent on Home's first-agent card.
- Cloud machine · Boat (`/cloud-computer`): 1 Connect your Boat account,
  2 Pick a size, 3 Create and pair, then Start an agent on Home.

## Sub-features

- `two-doors`: both doors show what they are, their time and what they need or
  cost; SSH is a link, never a third door.
- `step-times`: every step screen of both branches carries Step N of 3 and its
  own time; Home's first-agent card reads Step 3 of 3 · about 30 s.
- `price`: the Boat door's price is the cheapest size's per-hour price, the
  same number the size step shows.
- `large-text`: at 270 dp and text 2.0 the titles wrap whole words; nothing
  clips mid-line.
- `my-computer-run`: a clean install reaches a working agent terminal through
  the My computer door.

## Driving it

Native, the `two-doors` journey (`twoDoorsLab.mjs`): a release APK on a
task-owned emulator under the shared lock, in parts so each hold stays short.
Width parts shoot the doors, Get ready, Pair and the Boat account step at
360/390/445 dp text 1.0 and 270 dp text 2.0, light and dark, at rest and
scrolled; `tablet` shoots the doors side by side and the Boat account step at
1280 dp; `timed` installs clean, pairs a lab host on an isolated Herdr lab
session through the field, starts the agent (a `claude` stand-in) and reads its
answer back from the Herdr pane, writing `timing.json` with each step and the
slowest. The lab computer already has Tailscale and muxr, so those minutes are
not in the measured time.

Web, the `demo-first-run-pwa` journey: the demo cells, then `/connect`,
`/my-computer`, `/my-computer?step=pair` and `/cloud-computer` at
270/360/390/445/1280/1440 in both themes, each checked for the words it must
show, and a clip from the demo into the My computer pair step.

The Boat branch past the account step needs a signed-in Boat account and
spends money: run `cloud-setup` against the Boat stand-in, and the live
journeys only with approved cost.
