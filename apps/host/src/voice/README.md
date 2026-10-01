# muxr realtime voice

Realtime voice is product code. `product.mjs` is the surface the host and the app call; `@byokit/realtime` provides the native realtime speech-to-speech engines (ChatGPT voice for Codex Voice, Grok, Gemini Live, and OpenAI Realtime). Provider policy and credentials stay on the connected machine; the phone uses generic PCM or WebRTC realtime transport.

Settings → Voice & dictation is the single provider picker. A machine with no saved choice defaults to Codex Voice (experimental); explicit saved choices and migrated legacy choices remain selected. Configure opens the selected provider’s setup screen. Codex uses the machine’s ChatGPT CLI login (`codex login`), not an API key. Login readiness does not guarantee realtime subscription entitlement. Other providers use owner-only API key files and secure prompts.

`product.mjs` lists/selects providers and reports readiness. `stream.mjs` is the stream child: it reads the host's `realtime.open`, resolves API-key credentials from owner-only files, and runs the kit's `realtimeEngine` with muxr's prompt plus workspace context, tools, internal-id masks and hangup policy. For Codex, it passes the login resolver from `codex.mjs` to the kit, which resolves access while the phone starts media. The kit runs the provider in its own child with an empty environment. The native microphone foreground service must be ready before capture starts. No transcription/LLM/TTS fallback is used.

## Realtime work context and tools

The assistant can inspect the voice target, desktop focus, installed agent kinds, workspace/tab labels, task titles and lifecycle status. `inspect_app` adds the current phone view and up to five recently viewed live agents. Viewing history is bounded, local to the running app, and checked against a fresh host list; it is not inferred from lifecycle timestamps and is not persisted across app restarts.

For “send this to the agent I was using,” the assistant should inspect both contexts, offer a specific recipient and task when uncertain, and ask one short clarification. An omitted prompt target returns context without sending anything. Agent lookup also accepts a workspace label alongside name and task; a shared workspace remains ambiguous rather than selecting an agent. Unique prefixes and conservative typo matching still apply. `list_agents` treats blank or null optional `kind` and `query` filters as omitted, so an unfiltered request can return the live roster and count. Search and paging cover the live catalog rather than only its first page. Starting an agent accepts a concise title plus the complete initial instruction, and reports creation separately from whether that instruction was queued.

Once the user confirms a recipient, retain the original pending message and
invoke `prompt_agent` with that explicit target. “Ping it” and “ask it for an
update” are message requests, not status reads. Working agents can receive queued
follow-ups without an Escape/interrupt. Report the actual queue receipt, never
infer that the agent has already seen or answered the message.

Phone navigation and desktop focus are distinct actions. `focus_agent` focuses the desktop pane; `navigate_app` with `agent <name or task>` opens its live conversation on the phone. Semantic app tools are available in Grok, Gemini Live, OpenAI Realtime, and the Codex delegation bridge. Codex delegates natural-language work through its existing data channel; the backend translates it into restricted tool calls. Native audio transport is unchanged.

This is a bounded coordination tool surface, not unrestricted access to every Herdr command. Shell execution, arbitrary workspace deletion, and destructive agent termination are not added here. Broader capabilities need explicit action policy and a real user-confirmation path rather than a model-supplied approval flag. Each provider/device combination requires live verification; local scripted protocol tests alone do not establish audio or speech-recognition quality.

## Shared tool lifecycle

`voiceTools.mjs` holds the catalogue and one handler per tool. The kit's
`toolBridge` owns request bounds, deduplication, cancellation and the answer
watchdog; muxr supplies the per-tool budgets (`voiceToolTimeout`) and failure
wording (`voiceToolFailure`). The host coordinator remains the authority for
live membership, target resolution, reads, mutations and receipts; the mobile
semantic controller, reached through the kit's `appBridge`, remains the
authority for phone navigation.

`codexDelegation.mjs` handles Codex's natural-language client delegations with
**GPT-5.6-Sol**, without a model fallback. A single “ask/tell <agent> to
<instruction>” request for an agent in the session roster is sent directly to
`prompt_agent`, avoiding a planning turn; requests with further steps, unknown
targets, and other natural-language requests use the planner. The direct path
preserves the instruction text after removing the addressing phrase.
`@byokit/accounts` owns each
Responses request and parses streamed tool calls and text output; muxr retains
the bounded planning loop, conversation history and tool dispatch. Only the
existing `voiceTools` function catalog is sent to the account-bound Codex
Responses endpoint; no shell,
filesystem, MCP or other execution tools are exposed. The kit's `delegationHandler`
runs a structured `{ name, arguments }` request directly on the catalogued tools'
bridge, and never plans it. This is delegated tool reasoning, not an
STT/LLM/TTS replacement for the native speech-to-speech session.

Pending targets and messages remain in bounded, in-memory conversation history.
Natural-language planning is serialized; each planned request allows four model turns
and eight tool calls, with a 340-second overall deadline that includes long
agent watches. Closing voice aborts planning and active tools. A failed or
incomplete provider response cannot authorize new actions, and an uncertain
mutation is never automatically retried. Credentials remain host-only, redirects
are rejected, and test mode requires an explicit loopback fixture endpoint.

Codex may repeat a handoff with a fresh delegation ID while the same user turn
is still being processed. The kit's ChatGPT route shares one in-flight or
completed result for an identical trimmed request in that turn, including
clarifications and failures, so a repeated handoff cannot confirm its own pending
action or queue the message twice. A new user turn remains a new request, even
when its words match an earlier one. An ordinary new turn leaves an earlier
delegation running and reports its result; only an explicit interruption or
closing the call cancels it.

Reads have a 20-second deadline; mutations retain the existing 75-second
coordination budget, and explicit lifecycle watches keep their declared bound. Repeated operation IDs reuse the same result and cannot execute a
second mutation. The runtime stays thinking while a request is pending or a result
awaits an answer; if no completed answer arrives within 20 seconds, it exposes an
explicit error instead of silently returning to Listening. Engine receipt of a
transcript is a protocol observation, not proof of audible playback. Codex's
protocol acknowledgement filler is disabled; native speech/audio is unchanged.

`@byokit/accounts` still has no explicit Codex CLI folder adapter: its `fileStore` uses
Pi credentials, requires a sealing adapter since accounts 0.8.0, and `keepFresh`
uses Pi OAuth. `codex.mjs` therefore retains owner-only Codex folder reads,
app-server refresh and login status, using the
kit's `claims` to decode token claims. muxr calls only `claims` and `respond`
from accounts; neither host nor mobile creates an accounts credential store.
Upgrading to accounts 0.9.0 therefore requires no accounts store migration;
existing Codex sign-ins remain usable if they pass `codex.mjs`'s credential
checks. Codex owns its login file. `codex.mjs` refuses symlinked or non-regular
credential files, files owned by another user or accessible to other
users, and credential directories that are symlinked, owned by another user,
or writable by other users; it does not repair or migrate them. The kit
resolves the sign-in through `codex.mjs` as the `plan` access while the phone's
media starts, and a missing or unsafe login still closes the call with its remedy; the
kit's credential child owns the realtime-calls signaling and never frames the
token. A small planner fetch guard sets `parallel_tool_calls: false` and retains
response bounds, redirect rejection, reader cleanup and rejection of incomplete planning
responses (also rejected by accounts 0.9.0). The kit waits for EOF and does not
cancel the reader on parse errors; the guard closes it at completion or failure.
