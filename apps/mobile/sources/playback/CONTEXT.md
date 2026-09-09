# Playback

Native PCM output for one voice call.

## Language

**Realtime Playback**:
The native PCM sink for one voice call, including admission, backpressure, turn-finish drain, and ownership of drain acknowledgements.
_Avoid_: player, output buffer, audio service

**Stream Generation**:
The owner of audio currently draining. A replacement stream is a new generation and must not receive acknowledgements for previous audio.
_Avoid_: epoch, reconnect id, session id

**Output Drain**:
The ordered wait until native playback of admitted PCM has finished, before queued speech or a connected status for that turn may proceed.
_Avoid_: flush, complete, EOS

Use cases: [USE_CASES.md](../USE_CASES.md).
