# Voice

## Dictation

Dictation is local speech input using the bundled Whisper model. Audio stays on the phone.

## Realtime voice

Realtime voice is a public `host.stream` capability. The phone handles only provider-neutral PCM, transcript, state, and control frames. Credentials, model selection, prompts, tools, and provider event translation live in the realtime voice backend on your machine.

The default is experimental Codex Voice, using your existing Codex CLI login on the computer. You can choose another supported realtime provider using your own account; its key stays in an owner-only muxr file on that computer. Neither keys nor login credentials go to the phone, website, or relay. When you use realtime voice, audio goes to your chosen provider, along with its system prompt, tool schemas, requested tool arguments, and any tool output needed to answer. Tools that read terminal output can send excerpts when you explicitly request them.

Realtime provider usage may be billed by that provider. Set a provider budget and review its retention policy before enabling voice.
