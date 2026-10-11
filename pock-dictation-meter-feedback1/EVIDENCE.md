# Dictation meter feedback — evidence

Task: `pock-dictation-meter-feedback1`
Branch: `fm/pock-dictation-meter-feedback1` (base `5766e92963327dab50fd19dcca8a17f3732ba7fa`)

## The fix

`apps/mobile/sources/utils/dictation.ts` — the meter mapped the engine's energy
linearly to bar height, so quiet far-field speech drew a sub-pixel change. It now
maps it on a log scale between a floor and full scale:

```ts
const METER_FLOOR = 0.004;
const METER_SPAN = Math.log10(1 / METER_FLOOR);
export function dictationMeterLevel(energy) {
    if (!(energy > METER_FLOOR)) return 0;
    return Math.min(1, Math.log10(energy / METER_FLOOR) / METER_SPAN);
}
```

`@byokit/dictation` already emits an honest `level` (RMS of the frame); only the
visual scaling was too shallow. The stream gain is untouched.

## Test — fails before, passes after

`apps/mobile/sources/utils/dictation.spec.ts`: "moves the level for quiet
far-field speech and rests on true silence". Driving the real `quiet.wav`
fixture (−45 dBFS, normRms ~0.003–0.006, byokit level ~0.0125–0.024):

- Before the fix, the loudest bar was 0.02001953125 (`≤ 0.25`) → FAIL.
- After the fix it clears 0.25 and true silence stays 0 → PASS.

The whole spec file is 12/12 green. `yarn run check:fast` and the full
`yarn run check` suite are green.

## Build proof

Release APK built from this branch:
`~/.cache/fm-scratch/pock-dictation-meter-feedback1/apk-after/app-release.apk`
(x86_64, `com.trymuxr.app`). The bundled JS contains `dictationMeterLevel`
(`unzip -p … assets/index.android.bundle | grep -c dictationMeterLevel` = 1).

## Device proof — meter renders; microphone cannot be fed

On the task emulator (`emulator-5580`, AVD `fm-dictmeter1`) with the real built
APK, paired to a lab host and driven by maestro:

- At rest the composer strip is absent: **0 red bar columns** (`after-rest.png`).
- While dictation is live (maestro asserted "Stop dictation" visible), the strip
  renders exactly **5 red bars at the 4 dp base height (11 px)** — `after-f00.png`
  … `after-f13.png`, all `maxRun 11`.
- On stop the bars disappear again (`after-final.png`, `maxRun 0`).

The bars hold the base height because the app receives silence: this emulator
has **no working microphone input**, proven at the guest audio layer:

```
$ adb -s emulator-5580 shell su 0 tinycap /data/local/tmp/r3.wav -D 0 -d 0 -c 2 -r 48000 -b 16
… mean_volume: -90.3 dB  max_volume: -84.3 dB
```

- `-audio wav` + `QEMU_AUDIO_IN_DRV=wav` + `QEMU_WAV_PATH=mic.wav` +
  `adb emu avd rewindaudio`: guest capture still −90 dB.
- `-audio pa` (host PulseAudio, `dictmic` null-sink, default source
  `dictmic.monitor`): the emulator log reports `Could not init 'pa' audio
  driver` — this emulator build has no usable input backend.
- `adb emu avd hostmicon` does not change the guest capture.

So the empty→five-bar render path is proven on the real product, but the bar
**movement** for quiet speech cannot be shown on this emulator; the mapping that
drives it is covered by the failing-before/passing-after test above.

### Artifacts in this directory

- `after-rest.png`, `after-f00.png` … `after-f15.png`, `after-final.png` — real
  frames from the built APK.
- `after-result.json` — driver log.
- `guest-r3.wav`, `guest-r4.wav`, `guest-rec2.wav` — guest mic captures (silence).
- `emulator.log` — the `Could not init 'pa' audio driver` line.
- `measure.mjs` — the pixel measurement used above.

The release APK (`apk-after/app-release.apk`, x86_64) is rebuilt from this branch
with `node perf/buildPrApk.mjs <out>`; bulky scratch was removed per the fleet
`/tmp` rule.
