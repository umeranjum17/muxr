# muxr Voice plugin

The bundled xAI Grok speech-to-speech provider plugin. It uses the same public primitives, actions, slots, and `voice.*` semantic capabilities available to another provider.

- **Host:** `rpc.mjs` owns the provider key (`~/.muxr/xai.key`, owner-only). `stream.mjs` is the persistent `host.stream` adapter: it holds the xAI WebSocket, auth, model (`grok-voice-think-fast-2.0`), prompt, and event translation, and speaks only the generic realtime NDJSON frames.
- **Phone:** generic `icon-button` controls, a provider-neutral `realtime-session-overlay`, and PCM capture/playback. No API key, model name, provider URL, or provider event vocabulary is stored or known on the phone.
- **Settings:** choose Grok under Settings → Realtime voice, then open Configure. Secure prompt values go directly to its write RPC and are never persisted or rendered by declarative UI.
- **Swap:** the app asks the host to serialize the switch between plugins declaring `voice.session`; adding a provider never adds a React Native transport branch.
- **Removal:** clear the key from the plugin-owned Settings row, then `herdr plugin unlink muxr.voice`.
