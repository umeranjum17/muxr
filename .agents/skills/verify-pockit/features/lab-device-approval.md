# Approve a lab device pairing from the lab helper

The lab helper can hand its pairing offer to an external device, such as the Android app, and answer the computer's approval itself. The host's pairing socket then reports the device it approved. Without this step a device pairing in the lab stops at the approval check, because the helper's only pairing socket client pairs the helper itself.

## Sub-features

- `approveLabOffer` in `scripts/diagnostics/application/linkLabClient.mjs` hands the first offer to the caller, answers `{"approval"}` with `{"yes":true}`, and resolves with the host's `result` record.
- `linkHerdrLab(root, label, onEvent, beforeHost, hostEnv, presentOffer)` in `linkHerdrLab.mjs` takes the offer callback. Without it the helper pairs itself, as before. With it the returned `approved` is the device record and `link` is undefined.

## How to get to it (user POV)

Not a user-facing screen. A maintainer reaches it through a lab check that needs a real device to pair with a lab host. The user-visible pairing copy is covered by [pairing-consent.md](./pairing-consent.md).

## Driving it with the private stack

Preconditions: a guarded non-default Herdr lab from `fm-herdr-lab.sh` with `HERDR_LAB_HELPER` set to it; built `apps/host/dist/main.js` and `apps/relay/dist/main.js`; cwd is the checkout, because the helper spawns those paths relative to it. Never the `default` session, `muxr.service`, relay 8792 or the captain's `~/.muxr`.

1. Call `linkHerdrLab(root, 'label', undefined, undefined, {}, presentOffer)` with `root` a short private directory such as `~/.cache/fms/<short-name>/`.
2. In `presentOffer(text)`, hand `text` to the device (for example `adb shell am start` on a `muxr://pair#<offer>` link to the task's own emulator). Do not log the offer.
3. The device pairs and proves itself over the machine link. The helper answers approval and resolves `approved`; `approved.name` is the device name and `approved.deviceId` is set.
4. Stop with `lab.stop()` in a `finally`, then confirm each PID from `lab.pids()` is gone with `ps -p`.

## Gotchas

- The offer is a pairing credential for its lifetime (about two minutes). Keep it out of logs and evidence.
- `presentOffer` is called once, with the first offer. The host mints a fresh code after it answers the approval, and `approveLabOffer` does not hand that one over: delivering it to a device already pairing drops it back to a consent card for a code this call no longer serves.
- The approval wait is 120 s from the call. A device that never pairs fails the call with `timed out: approved device pairing`.
- A scratch driver that stands in for the device with `@byokit/pair` proves the approval step, not the Android app's own pairing UI.
