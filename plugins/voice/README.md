# muxr Voice plugin

One backend plugin provides native realtime speech-to-speech through Codex Voice, Grok, Gemini Live, or OpenAI Realtime. Provider policy and credentials stay on the connected machine; the phone uses generic PCM or WebRTC realtime transport.

Settings → Realtime voice is the single provider picker. A machine with no saved choice defaults to Codex Voice (experimental); explicit saved choices and migrated legacy choices remain selected. Configure opens the selected provider’s backend-declared setup screen. Codex uses the machine’s ChatGPT CLI login (`codex login`), not an API key. Login readiness does not guarantee realtime subscription entitlement. Other providers use owner-only API key files and secure prompts.

`rpc.mjs` lists/selects providers and reports readiness. `stream.mjs` dispatches to the selected adapter. The native microphone foreground service must be ready before capture starts. No transcription/LLM/TTS fallback is used.

## Realtime work context and tools

The assistant can inspect the voice target, desktop focus, installed agent kinds, workspace/tab labels, task titles and lifecycle status. `inspect_app` adds the current phone view and up to five recently viewed live agents. Viewing history is bounded, local to the running app, and checked against a fresh host list; it is not inferred from lifecycle timestamps and is not persisted across app restarts.

For “send this to the agent I was using,” the assistant should inspect both contexts, offer a specific recipient and task when uncertain, and ask one short clarification. An omitted prompt target returns context without sending anything. Name/task lookup supports unique prefixes and conservative typo matching; ambiguous matches remain choices. Search and paging cover the live catalog rather than only its first page. Starting an agent accepts a concise title plus the complete initial instruction, and reports creation separately from whether that instruction was queued.

Phone navigation and desktop focus are distinct actions. `focus_agent` focuses the desktop pane; `navigate_app` with `agent <name or task>` opens its live conversation on the phone. Semantic app tools are available in Grok, Gemini Live, OpenAI Realtime, and the Codex delegation bridge. Codex delegates catalog-defined JSON tool requests through its existing data channel; it no longer unconditionally refuses every delegation. Native audio transport is unchanged.

This is a bounded coordination tool surface, not unrestricted access to every Herdr command. Shell execution, arbitrary workspace deletion, and destructive agent termination are not added here. Broader capabilities need explicit action policy and a real user-confirmation path rather than a model-supplied approval flag. The new Codex delegation prompt/tool protocol and actual spoken target selection still require live provider/device verification; local scripted protocol tests alone do not establish audio or speech-recognition quality.
