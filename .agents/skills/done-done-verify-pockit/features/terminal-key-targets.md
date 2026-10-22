# Terminal keys and the quick-actions control are 48 dp targets

The terminal's key row (ctrl, shift, esc, tab, …) used to pack its keys to fit
the screen width, with 2-8 dp of padding and no gap, so on a narrow phone ctrl
and shift sat close enough that a tap on one landed on the other. Every key is
now a 48 dp square target with 4 dp between targets; its mark (and an armed
modifier's pill) stays 32 dp tall inside it. A row wider than the screen
scrolls, its trailing keys dissolving under the edge fade; the arrows are also
in the quick-actions ring's Arrows cluster.

The quick-actions control (the disc at the trailing end of the tabs row that
opens the ring) was a 24 dp disc leaning on 10 dp of hit slop right beside the
last tab. It now has its own 48 dp target and the tabs row keeps 8 dp clear of
it. The target reaches up over the terminal's last line and stops at the key
row's top edge, so it never covers a key. The disc itself is unchanged.

## Sub-features

- `key-target` every key in the row (Control and Shift first) is at least
  48 x 48 dp in the accessibility dump, at 390 and 270 dp, font 1.0 and 2.0.
- `key-gap` neighbouring keys never overlap; 4 dp sits between targets.
- `key-reach` a row wider than the screen scrolls, and every key reaches the
  screen whole.
- `modifier-pill` a locked modifier draws its pill inside its target.
- `control-target` the quick-actions control is 48 x 48 dp, with at least
  8 dp between it and the nearest tab, New tab or Latest chip.
- `control-opens` a tap on the control still opens the ring.

## How to get to it (user POV)

Home -> open an agent in a workspace with more than one tab. The tabs row and
the quick-actions disc sit under the terminal; the key row is under them,
above the composer.

## Driving it with the private stack

Preconditions: a release APK per side (`perf/buildPrApk.mjs` through
`fm-mem-gate.sh` with `FM_MEM_JOB_GB=16`), the shared emulator lock, `yarn build`.

```sh
MUXR_LAB_APK=<apk> MUXR_LAB_AVD_HOME=<scratch>/avd \
  flock -o -w 3600 /tmp/fm-muxr-emulator.lock timeout 1800 fm-mem-gate.sh done-done run key-targets
# or by hand, main first, then the candidate against it:
flock -o -w 3600 /tmp/fm-muxr-emulator.lock timeout 1800 fm-mem-gate.sh \
  node .agents/skills/done-done-verify-pockit/features/keyRowLab.mjs \
  --apk <apk> --evidence <ev>/<side> --avd-home <scratch>/avd [--ref <ev>/main]
```

The lab pairs to the fake stack (three tabs) and, per cell (`390-1.0-light`,
`390-1.0-dark`, `270-1.0-light`, `270-1.0-dark`, `270-2.0-dark`), opens an
agent, captures `terminal-<cell>.png` with its `visualCheck.mjs` dump, and
measures every whole key, the control and the nearest tab-row element in dp
into `metrics.json`. At 390 dp dark it also locks Control
(`terminal-ctrl-locked-…`) and opens the ring (`terminal-ring-…`). A key or the
control under 48 dp, overlapping keys, or less than 8 dp between the control
and the tabs is a DEFECT in `journey.log`; on main those DEFECT lines are the
before.

## Gotchas

- A key the screen edge cuts reports only its visible part in the dump, so the
  lab measures only keys whose right edge is clear of the screen's.
- `New tab` and `Latest` keep their own 8 dp hit slop, which the dump does not
  show; the 8 dp clearance is between their drawn boxes and the control's.
