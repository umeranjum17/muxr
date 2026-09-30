# muxr realtime voice providers

Realtime voice is product code. The app talks to typed `voice.*` host methods; `@byokit/realtime` owns the speech-to-speech engine, provider session, signaling, bounded tool bridge, and provider-blind phone call client. Muxr's host code selects providers, holds credentials, and supplies product prompts, tools, workspace context, and lifecycle policy. The phone supplies audio ports and app control; muxr owns microphone permission, foreground-service ordering, VAD-aware PCM capture, and native playback, while the kit owns the WebRTC peer and call lifecycle. There is no plugin catalog entry, manifest hash, or per-device plugin approval anywhere in this path. See [the native voice transport spec](specs/native-voice-transport.md) for transport details.

## Setup

The host bundle selects one of four `@byokit/realtime` engines:

| Engine | Provider | Transport | Default | Credential |
|---|---|---|---|---|
| `xai` | xAI Grok | host-relayed PCM | | `~/.muxr/xai.key` |
| `gemini` | Gemini Live | host-relayed PCM | | `~/.muxr/gemini.key` |
| `openai` | OpenAI Realtime | host-relayed PCM | | `~/.muxr/openai.key` |
| `codex` | Codex Voice (experimental) | mobile WebRTC | selected | owner-only local Codex ChatGPT OAuth |

Exactly one engine runs at a time. The selection is muxr's own state (`$MUXR_HOME/voice/provider`, owner-only), read by the `voice.provider.list` and `voice.provider.set` host methods. In the app, open **Settings → Voice & dictation** to switch. Grok, Gemini Live, and OpenAI Realtime collect their API key on the provider screen. Codex Voice uses the existing local `codex login`.

Keys are entered in a masked native prompt and sent once through authenticated E2EE. Codex OAuth never enters a muxr frame, phone, process argument, log, or muxr storage. Provider choices survive `npm` upgrades and subsequent `muxr setup` runs; a selection made under the retired voice plugin is carried into `$MUXR_HOME/voice/provider` by setup.

`MUXR_HOME` relocates the key directory. It is owner-only (`0700`); each key is owner-only (`0600`), written through a unique temporary file and atomic rename. Reads reject symlinks, non-regular files, and unsafe permissions.

## Boundary

The host exposes one product surface and keeps provider selection below the app-facing methods:

- `voice.status` — reports whether the selected provider is configured;
- `voice.provider.list` / `voice.provider.set` / `voice.provider.describe` — the engine table;
- `voice.key.set` / `voice.key.clear` — the machine-held key for the selected engine;
- `voice.stream` — a persistent provider-neutral realtime stream;
- `voice.report` — bounded agent-stop wording.

PCM providers use bounded audio/state/transcript/control frames over the encrypted product stream. Codex Voice uses bounded WebRTC signaling while mobile media flows directly to the provider. No provider name, model, credential, account id, private header, or event vocabulary enters the mobile kernel.

The `voice.session` capability key is gone; `voice.stream` is a product request gated by the same device authority as every other mutation.

Local Whisper dictation is separate, on-device, and does not require a realtime provider.
