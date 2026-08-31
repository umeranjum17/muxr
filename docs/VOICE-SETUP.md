# muxr realtime provider plugins

Realtime voice is ordinary plugin composition: generic capability buttons, a provider-neutral realtime overlay, and a declarative Settings destination. The mobile kernel owns microphone permission, foreground-service ordering, PCM capture/playback, and WebRTC media. Backend plugins own provider authentication, prompts, tools, event translation, and either host-relayed PCM or bounded WebRTC signaling.

## Setup

All four adapters ship inside `muxr.voice` with `@trymuxr/cli`:

| Adapter | Provider | Transport | Default | Credential |
|---|---|---|---|---|
| `xai` | xAI Grok | host-relayed PCM | selected | `~/.muxr/xai.key` |
| `gemini` | Gemini Live | host-relayed PCM | | `~/.muxr/gemini.key` |
| `openai` | OpenAI Realtime | host-relayed PCM | | `~/.muxr/openai.key` |
| `codex` | Codex Voice (experimental) | mobile WebRTC | | owner-only local Codex ChatGPT OAuth |

Exactly one adapter runs at a time. The selection is the plugin's own state under `MUXR_PLUGIN_STATE_DIR`, read by its `voice.provider.list` and `voice.provider.set` capabilities, so switching providers is not an enable/disable of separate packages. In the app, open **Settings → Realtime voice** to switch. Grok, Gemini Live, and OpenAI Realtime collect their API key through Configure. Codex Voice uses the existing local `codex login`.

Provider keys use attributed secure prompts sent once through authenticated E2EE. Codex OAuth never enters a muxr frame, phone, process argument, log, or muxr storage. Provider choices survive `npm` upgrades and subsequent `muxr setup` runs. The one-time upgrade from the former separate Gemini, OpenAI, or Codex plugin preserves the enabled provider, writes it into `muxr.voice` state, and enables the merged plugin.

`MUXR_HOME` relocates the key directory. It is owner-only (`0700`); each key is owner-only (`0600`), written through a unique temporary file and atomic rename. Reads reject symlinks, non-regular files, and unsafe permissions.

## Boundary

Core has no vendor-specific host handler. The generic plugin bridge resolves:

- `voice.status` — reports whether the provider is configured;
- `voice.key.set` — receives a key through the attributed secure prompt;
- `voice.session` — a persistent provider-neutral `host.stream`;
- `voice.report` — supplies plugin-owned wake wording.

The three PCM providers retain their existing bounded audio/state/transcript/control frames. A WebRTC provider exchanges only bounded SDP and opaque data-channel control through the encrypted plugin stream; mobile media flows directly to the provider. No provider name, model, credential, account id, private header, or event vocabulary enters the mobile kernel.

Local Whisper dictation is separate, on-device, and does not require this provider plugin.
