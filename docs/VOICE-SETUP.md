# muxr realtime provider plugins

Realtime voice is ordinary plugin composition: generic capability buttons, a provider-neutral realtime overlay, and a declarative Settings destination. The mobile kernel owns microphone permission, foreground-service ordering, PCM capture/playback, and WebRTC media. Backend plugins own provider authentication, prompts, tools, event translation, and either host-relayed PCM or bounded WebRTC signaling.

## Setup

All four adapters ship with `@trymuxr/cli`:

| Plugin | Provider | Transport | Default | Credential |
|---|---|---|---|---|
| `muxr.voice` | xAI Grok | host-relayed PCM | enabled | `~/.muxr/xai.key` |
| `muxr.voice-gemini` | Gemini Live | host-relayed PCM | disabled | `~/.muxr/gemini.key` |
| `muxr.voice-openai` | OpenAI Realtime | host-relayed PCM | disabled | `~/.muxr/openai.key` |
| `muxr.voice-codex` | Codex Voice (experimental) | mobile WebRTC | disabled | owner-only local Codex ChatGPT OAuth |

Exactly one provider may be enabled because all four claim `voice.session`. In the app, open **Settings → Realtime voice** to switch providers. Grok, Gemini Live, and OpenAI Realtime collect their API key through Configure. Codex Voice shows an explicit experimental OAuth/identity warning and uses the existing local `codex login`.

Provider keys use attributed secure prompts sent once through authenticated E2EE. Codex OAuth never enters a muxr frame, phone, process argument, log, or muxr storage. Provider choices survive `npm` upgrades and subsequent `muxr setup` runs.

`MUXR_HOME` relocates the key directory. It is owner-only (`0700`); each key is owner-only (`0600`), written through a unique temporary file and atomic rename. Reads reject symlinks, non-regular files, and unsafe permissions.

## Boundary

Core has no vendor-specific host handler. The generic plugin bridge resolves:

- `voice.status` — reports whether the provider is configured;
- `voice.key.set` — receives a key through the attributed secure prompt;
- `voice.session` — a persistent provider-neutral `host.stream`;
- `voice.report` — supplies plugin-owned wake wording.

The three PCM providers retain their existing bounded audio/state/transcript/control frames. A WebRTC provider exchanges only bounded SDP and opaque data-channel control through the encrypted plugin stream; mobile media flows directly to the provider. No provider name, model, credential, account id, private header, or event vocabulary enters the mobile kernel.

Local Whisper dictation is separate, on-device, and does not require this provider plugin.
