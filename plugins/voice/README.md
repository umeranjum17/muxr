# muxr Voice plugin

One backend plugin provides native realtime speech-to-speech through Codex Voice, Grok, Gemini Live, or OpenAI Realtime. Provider policy and credentials stay on the connected machine; the phone uses generic PCM or WebRTC realtime transport.

Settings → Realtime voice is the single provider picker. A machine with no saved choice defaults to Codex Voice (experimental); explicit saved choices and migrated legacy choices remain selected. Configure opens the selected provider’s backend-declared setup screen. Codex uses the machine’s ChatGPT CLI login (`codex login`), not an API key. Login readiness does not guarantee realtime subscription entitlement. Other providers use owner-only API key files and secure prompts.

`rpc.mjs` lists/selects providers and reports readiness. `stream.mjs` dispatches to the selected adapter. The native microphone foreground service must be ready before capture starts. No transcription/LLM/TTS fallback is used.

## Realtime work context and tools

The assistant can inspect the voice target, desktop focus, installed agent kinds, workspace/tab labels, task titles and lifecycle status. `inspect_app` adds the current phone view and up to five recently viewed live agents. Viewing history is bounded, local to the running app, and checked against a fresh host list; it is not inferred from lifecycle timestamps and is not persisted across app restarts.

For “send this to the agent I was using,” the assistant should inspect both contexts, offer a specific recipient and task when uncertain, and ask one short clarification. An omitted prompt target returns context without sending anything. Name/task lookup supports unique prefixes and conservative typo matching; ambiguous matches remain choices. Search and paging cover the live catalog rather than only its first page. Starting an agent accepts a concise title plus the complete initial instruction, and reports creation separately from whether that instruction was queued.

Phone navigation and desktop focus are distinct actions. `focus_agent` focuses the desktop pane; `navigate_app` with `agent <name or task>` opens its live conversation on the phone. Semantic app tools are available in Grok, Gemini Live, OpenAI Realtime, and the Codex delegation bridge. Codex delegates catalog-defined JSON tool requests through its existing data channel; it no longer unconditionally refuses every delegation. Native audio transport is unchanged.

This is a bounded coordination tool surface, not unrestricted access to every Herdr command. Shell execution, arbitrary workspace deletion, and destructive agent termination are not added here. Broader capabilities need explicit action policy and a real user-confirmation path rather than a model-supplied approval flag. The new Codex delegation prompt/tool protocol and actual spoken target selection still require live provider/device verification; local scripted protocol tests alone do not establish audio or speech-recognition quality.

## Shared tool lifecycle

`toolRuntime.mjs` is the provider-independent voice tool kernel. Every bundled
adapter uses its `voiceTools` catalog and `createVoiceTools` runtime. The existing
host coordinator remains the authority for live membership, target resolution,
reads, mutations and receipts; the mobile semantic controller remains the
authority for phone navigation. Provider-specific audio and wire events stay in
adapters. New adapters must translate calls into `tools.run`, return the result
using their protocol, call `tools.answered` on a completed assistant transcript,
forward app results to `tools.receive`, use `tools.state`, and close the runtime.
They inherit request bounds, deduplication, cancellation and failure reporting.

A plain-text delegation receives a read-only catalog and current-target output
through `tools.delegate`; it is never converted into a mutation by keyword
matching. The result names which target supplied the output and tells the voice
model to answer the original question or clarify a different target. Explicit
actions still require a catalog-defined structured call. Codex client delegation
can therefore summarize work without first emitting JSON, while prompts/focus
remain behind the same trusted dispatch as other providers.

Reads have a 15-second deadline; mutations retain the existing 75-second
coordination budget, and explicit lifecycle watches keep their declared bound. Repeated operation IDs reuse the same result and cannot execute a
second mutation. The runtime stays thinking while a request is pending or a result
awaits an answer; if no completed answer arrives within 20 seconds, it exposes an
explicit error instead of silently returning to Listening. Adapter receipt of a
transcript is a protocol observation, not proof of audible playback. Codex's
protocol acknowledgement filler is disabled; native speech/audio is unchanged.
