# Choose from one app-styled action sheet

On Android and the web/PWA, every `Modal.alert` and `Modal.confirm` (choices,
confirms and plain notices alike) opens one shared bottom sheet,
`apps/mobile/sources/modal/components/ActionSheet.tsx` on top of `OptionSheet`:
a title, the message, one row per choice with its icon when it has one, the
cancel row last, in the app's own colours for light and dark, clear of the
navigation bar. A tap outside, a swipe down on the handle or title, or back
dismisses it as its cancel. iOS keeps the system alert (a root sheet cannot
present over an already-open sheet there).

## Sub-features

- Add attachment: `Photo library`, `Camera` and `Files`, each with its icon;
  Files opens the system document picker.
- Long-press actions (Rename, Close pane) list the choices first and Cancel last
  on every platform.
- A sheet opened from inside another sheet (Close pane in the pane overview)
  shows above it.
- Dismissal: tap outside, swipe down, back; a confirm resolves `false`, an alert
  runs its cancel button (or its only button).

## How to get to it (user POV)

Home: tap `+` (Add attachment) in the dock; long-press an agent card. Agent
screen: tap the header to open the pane overview, long-press a pane tile, tap
Close pane.

## Driving it with the private stack

Preconditions: a release APK per side (`perf/buildPrApk.mjs` through
`fm-mem-gate.sh` with `FM_MEM_JOB_GB=16`), the shared emulator lock, `yarn build`.

```sh
flock -o -w 3600 /tmp/fm-muxr-emulator.lock timeout 1800 fm-mem-gate.sh \
  node .agents/skills/done-done-verify-pockit/features/actionSheetLab.mjs \
  --apk <main apk> --evidence <ev>/main --avd-home <scratch>/avd
# then the candidate, judged against main's dumps, with the dismissal checks:
  ... --apk <candidate apk> --evidence <ev>/candidate --ref <ev>/main --interact
```

The candidate side is also the `action-sheet` journey in `.done-done.yaml`
(`MUXR_LAB_APK`, `MUXR_LAB_AVD_HOME` set; `done-done run action-sheet`).

Each cell directory holds `<popup>-<width>-<font>-<theme>.png` and its dump from
`visualCheck.mjs`; `journey.log` lists every DEFECT and the PASS/FAIL of the
dismissal and Files checks.

## Gotchas

- The dock button and the sheet title are both labelled `Add attachment`; the
  sheet title is the last text node of that name.
- On main the popup is the system `AlertDialog` (capitals, grey box), so its
  dumps carry `android:id/button1` rows rather than app rows; `--ref` geometry
  comparison against it is a lead only.
