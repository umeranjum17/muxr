# muxr Voice plugin

One backend plugin provides native realtime speech-to-speech through Codex Voice, Grok, Gemini Live, or OpenAI Realtime. Provider policy and credentials stay on the connected machine; the phone uses generic PCM or WebRTC realtime transport.

Settings → Realtime voice is the single provider picker. A machine with no saved choice defaults to Codex Voice (experimental); explicit saved choices and migrated legacy choices remain selected. Configure opens the selected provider’s backend-declared setup screen. Codex uses the machine’s ChatGPT CLI login (`codex login`), not an API key. Login readiness does not guarantee realtime subscription entitlement. Other providers use owner-only API key files and secure prompts.

`rpc.mjs` lists/selects providers and reports readiness. `stream.mjs` dispatches to the selected adapter. The native microphone foreground service must be ready before capture starts. No transcription/LLM/TTS fallback is used.
