# Conversation

The live speech-to-speech call on this device.

## Language

**Mic Ownership**:
The exclusive claim among the realtime call, dictation, and VAD standby. They never own the microphone together.
_Avoid_: audio focus, recorder lock

**Desk Focus**:
The Agent the desktop has focused, used only when that Agent is working or blocked.
_Avoid_: last pane, current tab

**Voice Failure**:
What a stopped call means to the person holding the phone: one plain headline, a remedy when the refusal names one, and the provider's own words kept whole behind Details. Which refusals earn a remedy, and why 403 does not, lives in `domain/voiceFailure.ts`.
_Avoid_: error message, error string, provider error

Use cases: [USE_CASES.md](../USE_CASES.md).
