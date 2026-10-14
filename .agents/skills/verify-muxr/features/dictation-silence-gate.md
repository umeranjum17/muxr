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

## Driving it with the private stack

Preconditions: none for the stack — this path is on-device Whisper, not the
relay. Proof is file-fed only (no microphone, no speaker playback).

1. From a task scratch dir, build the kit's `whisperBench` and a host Silero
   `vadBench` against `node_modules/whisper.rn` 0.7.2.
2. Fetch `WHISPER_VAD_MODEL` with `installModel` (size + SHA-256).
3. Run the file-fed proof that mirrors
   `apps/mobile/sources/utils/localTranscription.ts` (vocabulary prompt, beam,
   energy preview gate, NON_SPEECH filter, plus `speech: { model, initWhisperVad }`)
   over `near-silence-0.003-120s`, `scripts/dictation/fixtures/quiet.wav`, and
   `clean.wav`.
4. Expect empty final for silence, non-empty correct-ish text for quiet and
   clean. Capture composer-draft screenshots (empty after silence, filled after
   quiet).

## Gotchas

- An energy-only gate at 0.015 drops quiet speech; do not "prove" silence by
  raising the RMS floor.
- If the VAD model is missing, the app continues without the neural gate — the
  silence case can hallucinate again. The proof must supply a verified local copy.
- Live previews are not Silero-gated; only finals and file readings are.
