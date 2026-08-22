# Gemini Live plugin

A bundled, default-off Gemini Live speech-to-speech provider. It claims the same public `voice.*` semantic capabilities as the bundled xAI provider, so exactly one realtime provider must be enabled.

- **Host:** `rpc.mjs` owns `~/.muxr/gemini.key` (owner-only). `stream.mjs` owns the Gemini WebSocket, model, prompt, tools, and translation to muxr's generic realtime NDJSON frames.
- **Phone:** only provider-neutral capture, playback, transcript, controls, and native plugin primitives. No Gemini URL, model, key, or event vocabulary reaches mobile code.
- **Enable:** choose Gemini Live under Settings → Realtime voice, then open Configure to set its key.
- **Disable:** choose another provider there. The Gemini key remains until cleared from its configuration screen.
