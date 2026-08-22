# muxr realtime provider plugins

Realtime voice is ordinary plugin composition: generic capability buttons, a provider-neutral realtime overlay, and a declarative Settings destination. The app kernel owns microphone permission, foreground-service startup, audio routing, and generic PCM/WebRTC capabilities. Each backend plugin owns its provider authentication, model, prompt, tools, codecs, and event translation.

## Setup

All three adapters ship with `@trymuxr/cli`:

| Plugin | Provider | Default | Key file |
|---|---|---|---|
| `muxr.voice` | xAI Grok | enabled | `~/.muxr/xai.key` |
| `muxr.voice-gemini` | Gemini Live | disabled | `~/.muxr/gemini.key` |
| `muxr.voice-openai` | OpenAI Realtime | disabled | `~/.muxr/openai.key` |

Exactly one provider may be enabled because all three claim `voice.session`. In the app, open **Settings → Realtime voice**, choose Grok, Gemini Live, or OpenAI Realtime, then open **Configure** to paste that provider's API key. The host serializes each switch so concurrent devices still converge on one provider.

The attributed secure prompt sends the value once through authenticated E2EE to that plugin's write RPC; declarative UI never stores or displays it. Provider and key choices survive `npm` upgrades and subsequent `muxr setup` runs.

`MUXR_HOME` relocates the key directory. It is owner-only (`0700`); each key is owner-only (`0600`), written through a unique temporary file and atomic rename. Reads reject symlinks, non-regular files, and unsafe permissions.

## Boundary

Core has no vendor-specific host handler. The generic plugin bridge resolves:

- `voice.status` — reports whether the provider is configured;
- `voice.key.set` — receives a key through the attributed secure prompt;
- `voice.session` — a persistent provider-neutral `host.stream`;
- `voice.report` — supplies plugin-owned wake wording.

The phone sends and receives only bounded audio, state, transcript, and control frames. The bundled adapters translate those frames to xAI `grok-voice-think-fast-2.0`, Gemini `gemini-3.1-flash-live-preview`, or OpenAI `gpt-realtime-2.1`. Another plugin can implement a different speech-to-speech provider without adding a provider branch to React Native. A backend may select a compiled generic WebRTC capability when that gives a better media path; provider endpoints and credentials still remain behind muxr signaling.

Local Whisper dictation is separate, on-device, and does not require this provider plugin.
