# AI-driven emulator testing for muxr

Research deliverable: which existing tools can an AI agent drive to replace or
augment manual emulator/device QA, and what fits muxr's architecture
(React Native + Expo + herdr) with the least new machinery.

## What muxr already automates today

The repo is not starting from zero. `perf/PR_GATE.md` and `perf/flows/*.yaml`
already run a **real local emulator** against the **real relay/host/fake-Herdr
stack with real E2EE pairing**:

- **Maestro 2.7.0** YAML flows (`perf/flows/`) tap and fling through the real
  app (`com.trymuxr.app`, test-signed release APK installed fresh by the gate).
- **adb is pinned to `--serial`**, emulator serials only, with an atomic
  per-emulator lock (`/tmp/muxr-pr-gate-<serial>.lock`) so parallel panes
  cannot collide.
- Assertions are deliberately **not pixel-based**: "the gate reads the host's
  own account of the stream" (`openSession.yaml` header). The host knows what
  the terminal stream did; screenshots are evidence, not oracles.
- `perf/prGate.mjs` / `releaseGate.mjs` wrap this into review and release
  lanes, plus OS samplers for performance pathology.

Manual QA today = a developer installing a build and tapping through journeys.
The question is which of those journeys an LLM agent can take over.

## Tool evaluation

### Maestro + its built-in MCP server — the primary fit

Maestro ships an MCP server (`maestro mcp`) that exposes
`list_devices`, `inspect_screen` (view hierarchy as compact JSON),
`take_screenshot`, `run` (accepts **inline YAML** with syntax validation), and
a `cheat_sheet`, to any MCP client (Claude Code, Codex, Cursor, Gemini, pi via
an MCP bridge). That is exactly the loop an agent needs: look at the screen,
author a step, run it, read the result, iterate — and when a journey
stabilizes, write the YAML back into `perf/flows/` as a permanent regression.

Why it fits muxr specifically:

- **Already the repo's standard.** Same runner, same version pin, same
  emulator/lock discipline, same fake-Herdr stack. Zero new infrastructure.
- Deterministic core with an agent on top: the agent explores with inline
  YAML, then *commits* the distilled journey as a normal flow the whole gate
  can replay. No AI in the CI path — AI is the author and the exploratory
  driver, the artifact stays deterministic.
- `inspect_screen` gives the agent the view hierarchy it needs; `muxr`'s
  terminal surface publishes exactly one accessibility label
  (`TERMINAL_SURFACE_LABEL` in `TerminalView.tsx`) and no resource ids, so
  text-locator flows are thin there — which the existing flows already work
  around by tapping named UI outside the terminal surface and asserting on
  host-side facts instead of pixels.

Cost: config only. `maestro mcp` is bundled in the installed CLI.

### Raw ADB + uiautomator dump + screencap — already proven, use for exploration

An LLM agent can absolutely drive a phone with nothing but adb:
`adb shell input tap/swipe/text`, `uiautomator dump` for the UI tree,
`exec-out screencap -p` for vision, `logcat -b crash` for evidence. OpenAI
publishes this exact loop as a first-party agent skill
(`openai/plugins/test-android-apps` → `android-emulator-qa`), and muxr's own
past emulator work (serial-pinned captures, UI-tree coordinate picking,
framestats gates) used the same pattern.

Verdict: real, but it is the **fallback layer, not the backbone**:

- `uiautomator dump` is slow (~1s) and unreliable mid-animation; the app is
  animation-heavy (Reanimated, Skia), so dumps often race the UI.
- It has no notion of flow, retry, or assertion — every one of those is
  reinvented in the agent's prompt.
- But it reaches where Maestro cannot: OS dialogs, system settings, pairing
  QR flows that leave the app, and quick bug reproduction ("install build,
  tap X, capture evidence").

### Appium — skip

Appium's WebDriver stack adds a server/session layer the repo doesn't need;
its AI story is third-party plugins (Appium AI element queries, HeadSpin's
LLM plugin, community `appium-mcp`) that churn faster than they stabilize.
Maestro already covers the same "drive a real device" ground with less
machinery, and muxr has already validated it on its own stack.

### Detox — skip

Detox's gray-box RN synchronization is attractive in theory, but it is a
*coded* framework: it makes deterministic tests stable, it does not let an
agent *drive* anything at runtime. Its sync layer is also historically
fragile with exactly muxr's stack (Reanimated, Skia/canvaskit, native
Ghostty view). Keeping it out avoids a second parallel UI-test runtime.

### Espresso — not in scope

JVM instrumentation tests are deterministic unit-scale UI checks. An agent
cannot "run Espresso" exploratorily; it can only author tests that gradle
runs. Wrong layer for the captain's ask (replace manual device QA).

### Research LLM phone agents (AndroidWorld, AppAgent, MobileAgent) — evidence, not infrastructure

Google's AndroidWorld (116 tasks across 20 real apps), AppAgent and
MobileAgentBench all demonstrate that LLM+vision agents can operate real
Android GUIs at a useful success rate. They are benchmarks/research stacks,
not things to adopt; they matter here as proof the hybrid approach works and
as a source of patterns (UI-tree + screenshot fusion, step-limited episodes,
programmatic task checks).

### Commercial AI-native platforms (testRigor, mabl, aviation.dev, …) — wrong trust model

These are cloud recorders/runners with per-seat pricing. muxr is
local-first and self-hostable; its QA has to drive **local pairing, local
relays, and E2EE fixtures**. Shipping app screens and pairing material through
a third-party cloud is both a data-path mismatch and a cost model mismatch.

## Recommendation: three layers on the existing substrate

1. **Deterministic backbone (exists).** Maestro YAML flows in `perf/flows/`
   keep guarding release journeys in `check`/PR/release gates. New features
   land with a flow.
2. **Agent-driven authoring and verification (add this — config only).**
   Register `maestro mcp` with the coding agents that already work in herdr
   panes on this machine. The agent's job: given a journey ("pair a fresh
   device", "open a session and send `muxr show-image`"), drive it on the
   dedicated locked emulator with inline YAML, verify with
   `inspect_screen`/`take_screenshot` plus host-side facts, and leave behind
   (a) a stable committed flow, (b) screenshots, (c) logcat, (d) an explicit
   pass/fail statement. Screenshots can be rendered straight to the captain's
   phone with `muxr show-image` — the same feature this brief ships — so agent
   QA evidence arrives inline where the captain reads.
3. **Exploratory adb loop (already practiced, formalize).** For bug reports
   and odd states, the agent uses raw adb + uiautomator + screencap per the
   `android-emulator-qa` pattern, always serial-pinned under the existing
   per-emulator lock, always producing the same evidence bundle.

Hard rules carried over from the current gate (they become agent rules):
dedicated idle emulator only; the gate owns its relay (`MUXR_RELAY_PORT=0`,
real port from the child); serial-pinned adb; fresh install of the
test-signed APK; no pixel assertions where a host-side fact exists; never
display or speak internal ids in produced evidence captions.

## Effort estimate

| Item | Effort |
|---|---|
| Register Maestro MCP for agents + a muxr QA skill/instructions page | hours |
| PoC: agent verifies pairing journey via `pair.yaml` + evidence bundle | ~1 day |
| Agent-authored flow for a new feature, reviewed into `perf/flows/` | 2–3 days |
| Nightly exploratory agent run with bug-report template | ~1 week (incl. flakiness triage) |

No new runtime dependencies. Maestro stays pinned at its current version;
the agent layer is prompt/MCP configuration, not code.

## Proof-of-concept plan

1. **PoC 1 — replay.** Give an agent (in a herdr pane, dedicated emulator) the
   Maestro MCP and one instruction: verify the pairing journey. Success:
   agent runs `pair.yaml`, captures before/after screenshots + logcat, states
   pass/fail with evidence paths, and does not touch another emulator.
2. **PoC 2 — author.** Task the agent with a journey that has no flow yet
   (the inline-image journey this brief adds: open a session, run
   `muxr show-image`, assert the strip). Success: a reviewed YAML flow lands
   in `perf/flows/` and passes the PR gate twice in a row.
3. **PoC 3 — explore.** Nightly unguided run: fresh build, seeded fake-Herdr
   world, agent explores N minutes with a bug-report template (steps,
   screenshots, logcat, expected-vs-actual). Success: at least one
   actionable, reproduced finding, and zero reports that a human cannot
   replay from the evidence bundle.

## Risks

- **Vision assertions are seductive and flaky.** Keep the repo's rule: assert
  on host-side facts first, screenshots as evidence only.
- **Emulator contention.** The per-serial lock exists because panes already
  fight over emulators; agents must take the same lock or fail loudly.
- **Model cost/latency** for exploratory runs is real but bounded by
  step-limited episodes and nightly cadence, not per-PR.
- **Maestro MCP churn.** It ships inside the pinned CLI, so agent-facing
  tools move only when the repo chooses to move.
