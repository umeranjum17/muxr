# muxr Voice provider plugin

`muxr.voice` is the bundled xAI Grok speech-to-speech adapter. Its UI is ordinary plugin composition: generic capability buttons, a provider-neutral realtime overlay, a declarative Settings destination, and a shortcut. The app kernel owns microphone permission, foreground-service startup, audio routing, and generic PCM/WebRTC capabilities. The backend plugin owns provider authentication, models, prompts, tools, codecs, and event translation.

## Setup

In a source checkout, `yarn build` plus the documented setup flow installs bundled plugins. Open **Settings → Grok realtime voice**. Its secure prompt sends the value once through authenticated E2EE to the plugin's write RPC; declarative UI never stores or displays it.

The plugin stores the key only on the machine at:

```text
~/.muxr/xai.key
```

`MUXR_HOME` relocates the directory. It is owner-only (`0700`); the key is owner-only (`0600`), written through a unique temporary file and atomic rename. Reads reject symlinks, non-regular files, and unsafe permissions.

## Boundary

Core has no vendor-specific host handler. The generic plugin bridge resolves:

- `voice.status` — reports whether the provider is configured;
- `voice.key.set` — receives a key through the attributed secure prompt;
- `voice.session` — a persistent provider-neutral `host.stream`;
- `voice.report` — supplies plugin-owned wake wording.

The phone sends and receives only bounded audio, state, transcript, and control frames. The bundled backend translates those frames to xAI `grok-voice-think-fast-2.0`. Another plugin can implement OpenAI, Gemini Live, or another speech-to-speech provider without adding provider branches to React Native. A backend may select a compiled generic WebRTC capability when that gives a better media path; provider endpoints and credentials still remain behind muxr signaling.

Local Whisper dictation is separate, on-device, and does not require this provider plugin.
