# Long silence never fills the composer

Holding the mic on near-silence or room noise must leave the Home composer
empty. Quiet speech and a normal take still decode into the draft. The phone
runs Silero VAD (`speech:` on `whisperRnEngine`) before every final decode.

## Sub-features

- `silence-empty` 120 s of near-silence / room-noise (file-fed) yields empty
  final text for the composer draft.
- `quiet-speech` the kit/muxr quiet fixture still produces the intended words.
- `clean-unchanged` a normal clean fixture still transcribes.

## How to get to it (user POV)

Open Home, hold the mic, speak or stay quiet, release. The draft above Send
shows what dictation settled on.

## Driving it

Preconditions: a task-owned Android emulator with a debug APK built from the
candidate, with `EXPO_PUBLIC_MUXR_LAB_DICTATE=1` set at bundle time. This is
on-device Whisper, not the relay. Proof is file-fed only (no microphone, no
speaker playback).

Lab seam: `apps/mobile/sources/utils/dictationLabFeed.ts`, consumed by
`dictationMicrophone.ts` `open()`. When the flag is set and
`<app files>/muxr-lab-dictation.pcm` exists, the next take plays that file
(raw little-endian PCM16 mono, 16 kHz) through the normal
`startLiveTranscription()` path: `acquireEngine`, the bundled Silero context,
and `finish()` all run as shipped. The flag is inlined at bundle time, so
production has no branch and no hardware-mic change.

Steps:
1. Generate the 120 s near-silence take at proof time: PCM noise at about
   0.003 RMS, 120 s, 16 kHz mono. It is not committed. Quiet and clean takes
   come from `scripts/dictation/fixtures/quiet.wav` and `clean.wav` (convert to
   raw PCM16 with the same rate).
2. For each take, push the PCM into the app's files directory with
   `adb shell run-as <package> cp` (or `adb push` to a temp path, then
   `run-as`), then hold the mic on Home in the app, release, and read the
   composer draft.
3. Assert: the silence take leaves the draft empty; quiet and clean produce
   their words. Capture composer-draft screenshots (empty after silence, filled
   after quiet). Log partials on the silence take, since partials are only held
   back by the energy gate.

The 120 s take is longer than the kit's 30 s window, so it also exercises the
0.5.0 windowing change.

Supporting evidence: the kit's own proof with `@byokit/dictation` 0.5.0 (WER
CLI) against the same fixtures. Evidence goes under `~/.no-mistakes/evidence`,
not the diff.

This feature is not yet run. Its status is pending until the evidence exists.

## Gotchas

- An energy-only gate at 0.015 drops quiet speech; do not "prove" silence by
  raising the RMS floor.
- If the Silero context cannot open, the take continues without the neural gate
  and the silence case can hallucinate again. Only a successful open is cached,
  so the next take probes again.
- Live previews are not Silero-gated; only finals and file readings are.
