# OpenAI Realtime plugin

A bundled, default-off OpenAI Realtime speech-to-speech provider. It claims the same public `voice.*` semantic capabilities as the bundled xAI provider, so exactly one realtime provider must be enabled.

- **Host:** `rpc.mjs` owns `~/.muxr/openai.key` (owner-only). `stream.mjs` owns the OpenAI WebSocket, model, prompt, tools, and translation to muxr's generic realtime NDJSON frames.
- **Phone:** only provider-neutral capture, playback, transcript, controls, and native plugin primitives. No OpenAI URL, model, key, or event vocabulary reaches mobile code.
- **Enable:** choose OpenAI Realtime under Settings → Realtime voice, then open Configure to set its key.
- **Disable:** choose another provider there. The OpenAI key remains until cleared from its configuration screen.
