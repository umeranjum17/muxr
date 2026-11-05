# Dictation read on the computer by Hex

With Settings → Voice & dictation → **Transcribe on my computer** on, a dictation
take is recorded on the phone, sent over the existing link as one WAV
(`dictation.transcribe`), read by Hex (`hex model transcribe`, local, MIT) on the
paired computer, and the text returns into the same composer field. No cloud
engine; the phone loads no model for that take.

## Sub-features

- `setting-on` the switch reads on and its footer names Hex.
- `computer-clean` the clean fixture take fills the Home draft with its words.
- `host-reading` the host log has a `dictation: Hex transcribed …` line for it.

## Driving it

Preconditions: a release APK built with `EXPO_PUBLIC_MUXR_LAB_DICTATE=1`, a
task-owned emulator, and a Hex wrapper script (the downloaded Hex release with a
throwaway `HOME`/`XDG_DATA_HOME` and `hex model install parakeet_unified_en`
done once) as `MUXR_HEX_LAB`. The lab host gets it as `MUXR_HEX_BIN` and
`MUXR_DICTATION_LOG_TEXT=1`, which keeps the words in its log for this proof only.

```sh
node .agents/skills/done-done-verify-pockit/features/dictationLab.mjs --apk <apk> \
  --evidence <dir> --avd-home <dir> --computer "$MUXR_HEX_LAB"
```

Journey name: `dictation-computer`. Writes `computer-setting-on.png`,
`computer-clean-after.png` (the phone draft beside the host Hex log line and model), `host-dictation.log` and
`dictation-lab.log`. The host here is the real built host over the perf fake
stack; only Herdr is faked.

## Gotchas

- A host without Hex answers `Hex is not installed on this computer…`; one without
  the model answers with Hex's own message. The phone shows it as "Dictation failed".
- One request per take, no live words while speaking (`finalReading: 'recording'`).
- The 40 s request bound is raised to 70 s on the phone: Hex's first read loads the model.
