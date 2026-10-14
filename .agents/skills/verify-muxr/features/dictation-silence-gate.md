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

Preconditions: a task-owned Android emulator with the candidate APK installed.
This is on-device Whisper, not the relay. Proof is file-fed only (no microphone,
no speaker playback).

The proof drives the shipped `startLiveTranscription()` in
`apps/mobile/sources/utils/localTranscription.ts`, so it runs the real
`acquireEngine` and `finish()` path with the bundled Silero model
(`apps/mobile/sources/assets/models/ggml-silero-v6.2.0.bin`). Feed the audio
through the dictation microphone seam (`apps/mobile/sources/utils/dictationMicrophone.ts`)
with `near-silence-0.003-120s`, `scripts/dictation/fixtures/quiet.wav` and
`clean.wav`. That file-feed seam does not exist yet: adding it is the first step
of this proof, and it must stay out of the shipped path.

Expect an empty final for the 120 s silence take and non-empty text for quiet and
clean. Capture composer-draft screenshots (empty after silence, filled after
quiet), and log partials on the silence take, since partials are only held back
by the energy gate.

Supporting evidence: the kit's own proof with `@byokit/dictation` 0.5.0 (WER CLI)
against the same fixtures. Evidence goes under `~/.no-mistakes/evidence`, not the diff.

## Gotchas

- An energy-only gate at 0.015 drops quiet speech; do not "prove" silence by
  raising the RMS floor.
- If the bundled VAD model fails to load, the app continues without the neural
  gate and the silence case can hallucinate again. The failure is not cached, so
  the next take retries the load.
- Live previews are not Silero-gated; only finals and file readings are.
