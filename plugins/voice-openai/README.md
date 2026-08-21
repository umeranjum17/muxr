# OpenAI Realtime plugin

A bundled, default-off OpenAI Realtime speech-to-speech provider. It claims the same public `voice.*` semantic capabilities as the bundled xAI provider, so exactly one realtime provider must be enabled.

- **Host:** `rpc.mjs` owns `~/.muxr/openai.key` (owner-only). `stream.mjs` owns the OpenAI WebSocket, model, prompt, tools, and translation to muxr's generic realtime NDJSON frames.
- **Phone:** only provider-neutral capture, playback, transcript, controls, and native plugin primitives. No OpenAI URL, model, key, or event vocabulary reaches mobile code.
- **Enable:** disable the current `voice.session` provider, then run `herdr plugin enable muxr.voice-openai`. Configure its key from Settings → Plugins.
- **Disable:** `herdr plugin disable muxr.voice-openai`. The key remains until cleared from the plugin settings screen.
