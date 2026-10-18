# Long silence never fills the composer

Holding the mic on near-silence or room noise must leave the Home composer
empty. Quiet speech and a normal take still decode into the draft. The phone
runs Silero VAD (`speech:` on `whisperRnEngine`) before every final decode.

## Sub-features

- `silence-empty` 40 s of near-silence / room-noise (file-fed) yields empty
  final text for the composer draft.
- `quiet-speech` the kit/muxr quiet fixture still produces the intended words.
- `clean-unchanged` a normal clean fixture still transcribes.

## How to get to it (user POV)

Open Home, tap Dictate, speak or stay quiet, then tap Stop once. The draft
shows what dictation settled on.

## Driving it with the private stack

Preconditions: a task-owned Android emulator and a release APK built from the
candidate with `EXPO_PUBLIC_MUXR_LAB_DICTATE=1` set at bundle time. This is
on-device Whisper, not the relay. Proof is file-fed only (no microphone, no
speaker playback).

Lab seam: `apps/mobile/sources/utils/dictationLabFeed.ts`, consumed by
`dictationMicrophone.ts` `open()`. When the flag is set and
`<app files>/muxr-lab-dictation.pcm` exists, the next take plays that file
(raw little-endian PCM16 mono, 16 kHz) through the normal
`startLiveTranscription()` path: `acquireEngine`, the bundled Silero context,
and `finish()` all run as shipped. The flag is inlined at bundle time, so
production has no branch and no hardware-mic change.

Run `dictationLab.mjs` from the repo root after `yarn build`:

```sh
EXPO_PUBLIC_MUXR_LAB_DICTATE=1 node perf/buildPrApk.mjs <out>
node .agents/skills/verify-pockit/features/dictationLab.mjs --apk <out>/app-release.apk \
  --evidence <dir> --avd-home <dir> [--launcher <host memory gate>]
```

Under the host's fleet tools, wrap it in the shared emulator lock with a time
bound. Pass the memory gate as `--launcher` so the gate meters only the
emulator. What the script does:

1. Clean data: uninstall, install, grant mic and notifications, then pair
   through the perf fake stack. An install over old data carries any earlier
   session or setting across, so a proof must start from an uninstall.
2. Takes on Home: quiet, the 40 s near-silence (generated at run time, about
   0.003 RMS), then clean. Quiet and clean come from
   `scripts/dictation/fixtures/`. Each take feeds the PCM, taps Dictate, taps
   Stop once, waits for the strip to settle, and saves `<take>-after.png` and
   `<take>-after.xml.json`.
3. An install over that data, then one more quiet take.
4. One log line saying whether realtime voice opened at any point:
   `realtime: none opened (…)`. It combines three checks: the voice foreground
   service running with the microphone type, sampled every 2 s; the app's
   RECORD_AUDIO app-op; and the realtime pill, sheet or alert seen in any dump.

Assert: silence leaves the draft empty, quiet and clean produce their words,
and the composer stays visible with `realtime: none opened`.

The 40 s take is longer than the kit's 30 s window, so it also exercises the
0.5.0 windowing change. A 120 s take was still "Transcribing…" after 15 min
on a loaded fleet emulator, which does not fit one lock hold.

Optional supporting check: the kit's WER CLI for `@byokit/dictation` 0.5.0 on
the same fixtures. No result is recorded in this repo; the phone run above is
the proof. Evidence goes under `~/.no-mistakes/evidence`, not the diff.

Status: run13 of the realtime-mic-claim proof, kept in the private evidence store,
passed all four takes: clean-quiet, clean-silence (empty draft), clean-clean,
and reinstall-quiet after `install -r` over old data. Its log reads `realtime:
none opened (microphone service samples running=0 of 570 successful dumps in 572
attempts, RECORD_AUDIO never accessed, realtime on screen in 0 of 204 screens)`.
Every tap the lab's own steps make is logged by label (Pair, Dictate, Stop
dictation, draft field, composer input), and none is a Talk control. The shared
dismiss helpers tap by coordinate or send BACK without a log line.
`voice-service-dumpsys.txt` shows `VoiceOverlayService` started by `voiceOverlay.herdStart` with `types=0x00000001`,
the herd keep-alive, so the microphone-type check reads the real format.

## Gotchas

- An energy-only gate at 0.015 drops quiet speech; do not "prove" silence by
  raising the RMS floor.
- If the Silero context cannot open, the take continues without the neural gate
  and the silence case can hallucinate again. Only a successful open is cached,
  so the next take probes again.
- Live previews are not Silero-gated; only finals and file readings are.
- The take does not end on its own: the kit keeps recording after the fed
  file runs dry, until Stop. Tap Stop exactly once, found by its label in a
  fresh dump. Never tap a remembered coordinate again. After the take, Send sits
  where Stop was, so a second blind tap sends the draft to a new agent. The
  next blind tap on that spot hits the agent's "Talk to this session"
  (`RealtimeTalkButton`, an empty draft's trailing action in
  `TerminalScreen.tsx`), which starts realtime voice. The realtime sheet then
  covers the composer and holds the mic, and dictation reports busy. This
  looks like the app starting a session on its own. Home has a Talk button
  too. In run10 (`evidence/run10/failure.png`) the alert sits over Home with the
  lab's draft still in the composer. That run's log has no tap labels, so the
  Talk tap is inferred from the Home Talk glyph, not logged. Run13 shows no
  session from wake-on-speech or stale data: its reinstall-quiet stage after
  `install -r` has no microphone type, and `vadStandbyEnabled` is off by default.
- `adb root` (needed to copy the feed into a release build's files) restarts
  adbd and drops `adb reverse`, so pair first, root after, then re-apply the
  reverse.
- `perf/flows/pair.yaml` predates the "Let's connect" first run and waits for
  "Other ways to connect" until it times out. The lab opens the offer as
  `muxr://pair#<offer>` and taps Pair on the consent card instead.
- `VoiceOverlayService` running does not mean realtime voice. The same
  service class runs the herd keep-alive (`dataSync`) while agents work, so it
  turns on and off as the lab agents cycle. Only the microphone foreground type
  is realtime.
- With the composer closed, the draft is a one-line text beside Dictate, not an
  EditText. Tapping it opens the full composer screen (agent, folder and
  worktree pickers). Clear the draft there, then go back to Home before the
  next take: on that screen Dictate's row also holds the agent picker.
