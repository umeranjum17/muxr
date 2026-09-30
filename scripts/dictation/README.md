# Dictation bench

Word error rate (WER) and time-to-text of on-device dictation settings, on a fixed set of
recordings, through the same whisper.cpp code the phone runs.

```sh
node scripts/dictation/benchDictation.mjs scripts/dictation/candidates.json --speed 3
```

- `fixtures/` holds 16 kHz mono PCM16 WAVs and `fixtures.json`: each clip's id, kind and
  the text the speaker meant (`speak` is what the voice was given when a written word is
  not how people say it, like `muxr`).
- `candidates.json` names settings to compare. `whisper` holds whisper.rn `transcribeData`
  options (`audioCtx: "fit"` is the app's window sized to the audio; `prompt` is a fixed
  vocabulary hint). A candidate with `live` replays the app's live reading loop from
  `apps/mobile/sources/utils/localTranscription.ts` on a clock: audio arrives in real
  time, a reading takes its measured time times `--speed`, finished segments are kept once
  a reading is past `keepAfterSeconds`, and stop waits for what is left. Without `live`
  the whole recording is read once after stop. `final` overrides `whisper` for one
  last reading at stop.
- The first run builds `whisperBench` from `node_modules/whisper.rn/cpp` with the source
  list and flags of whisper.rn's Android build into `node_modules/.cache/dictation-bench/`.
  `whisperBench.cpp` fills `whisper_full_params` exactly as whisper.rn's
  `createTranscribeConfig` does, so a setting means here what it means on the phone.
  Needs a C/C++ toolchain.
- The wait column is the time from stop to the final text. `--speed 3` scales host
  readings to the phone: a 3 s reading takes ~0.16 s on a 32-core x86 host and
  ~0.45 s on a Snapdragon 8 Elite. WER and wait are medians over `--repeats`.
- `--fixtures other/fixtures.json` runs another set in the same format; `--only id,id`
  picks clips; `--model path` swaps the model; `--json out.json` keeps every transcript.

## Fixtures

Made by `makeFixtures.py` with Piper TTS and the `en_US-ljspeech-high` voice, which is
trained from scratch on the public-domain LJ Speech set. Lower-pitched speakers are the
same voice shifted; hiss is seeded pink noise, babble is the same voice saying other
sentences, reverb is a synthetic room. `quiet` sits at -45 dBFS, about where Android's
`VOICE_RECOGNITION` source puts speech at arm's length. No microphone was used.
