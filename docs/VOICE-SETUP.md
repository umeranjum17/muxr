# muxr realtime voice providers

Realtime voice is product code. The app talks to typed `voice.*` host methods; the host owns the adapter runtime under `apps/host/src/voice/`. There is no plugin catalog entry, manifest hash, or per-device plugin approval anywhere in this path. The mobile kernel owns microphone permission, foreground-service ordering, PCM capture/playback, and WebRTC media. The host adapters own provider authentication, prompts, tools, event translation, and either host-relayed PCM or bounded WebRTC signaling.

## Setup

All four adapters ship inside `@trymuxr/cli` as `voice/` beside the host bundle:

| Adapter | Provider | Transport | Default | Credential |
|---|---|---|---|---|
| `xai` | xAI Grok | host-relayed PCM | | `~/.muxr/xai.key` |
| `gemini` | Gemini Live | host-relayed PCM | | `~/.muxr/gemini.key` |
| `openai` | OpenAI Realtime | host-relayed PCM | | `~/.muxr/openai.key` |
| `codex` | Codex Voice (experimental) | mobile WebRTC | selected | owner-only local Codex ChatGPT OAuth |

Exactly one adapter runs at a time. The selection is muxr's own state (`$MUXR_HOME/voice/provider`, owner-only), read by the `voice.provider.list` and `voice.provider.set` host methods. In the app, open **Settings → Voice & dictation** to switch. Grok, Gemini Live, and OpenAI Realtime collect their API key on the provider screen. Codex Voice uses the existing local `codex login`.

Keys are entered in a masked native prompt and sent once through authenticated E2EE. Codex OAuth never enters a muxr frame, phone, process argument, log, or muxr storage. Provider choices survive `npm` upgrades and subsequent `muxr setup` runs; a selection made under the retired voice plugin is carried into `$MUXR_HOME/voice/provider` by setup.

`MUXR_HOME` relocates the key directory. It is owner-only (`0700`); each key is owner-only (`0600`), written through a unique temporary file and atomic rename. Reads reject symlinks, non-regular files, and unsafe permissions.

## Boundary

The host exposes one product surface and never branches on a provider name above the adapter:

- `voice.status` — reports whether the selected provider is configured;
- `voice.provider.list` / `voice.provider.set` / `voice.provider.describe` — the adapter table;
- `voice.key.set` / `voice.key.clear` — the machine-held key for the selected adapter;
- `voice.stream` — a persistent provider-neutral realtime stream;
- `voice.report` — bounded agent-stop wording.

The three PCM providers retain their existing bounded audio/state/transcript/control frames. A WebRTC provider exchanges only bounded SDP and opaque data-channel control through the encrypted plugin stream; mobile media flows directly to the provider. No provider name, model, credential, account id, private header, or event vocabulary enters the mobile kernel.

The `voice.session` capability key is gone; `voice.stream` is a product request gated by the same device authority as every other mutation.

Local Whisper dictation is separate, on-device, and does not require a realtime provider.
