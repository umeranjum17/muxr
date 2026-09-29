## Live validation: presence chip on the real PWA (lab host)

Driven on `9dfb73f` (this PR, rebased on main with #529/#530/#533/#536). An isolated lab setup:
- a foreground host and relay from this checkout on 127.0.0.1:28792, with a private `MUXR_HOME` and its own Herdr lab session;
- desklink 0.2.0 keeper, so each agent pane gets its own private Xvfb screen;
- the web export of this branch, served by that relay and paired as a control browser;
- a real Claude Code agent started from the PWA's New agent sheet, opening its browser with `agent-browser` (headed through the pane's `AGENT_BROWSER_*`).

The phone-side timeline was sampled about once a second. The pane's X windows were sampled every 250 ms. Screens are 393×852 and 270×594, the reference viewport. The terminal screen is dark in every theme by design (`terminalChrome` in `theme.ts`), so there is no light-theme variant of the chip.

| # | Scenario | Result |
|---|---|---|
| 1 | Agent opens a browser while the channel is live: header chip with live dot, tooltip offers Watch, Watch opens the live view | **PASS**, with one bug found (below). Window mapped → chip with dot and tooltip in 2.7 s (≤ 3.3 s at 270 dp); tooltip collapses after about 6 s; **Watch** → `?desktop=preview`, live view of the pane's screen playing 1280×800 at 38 fps with motion; Pane actions shows **Watch browser** |
| 2 | Link drops with stale preview metadata: chip keeps its place, dimmed without the dot; tooltip quiet; Watch cannot open | **PASS**. Relay stopped → about 1 s later the chip is at opacity 0.5, no dot, `aria-disabled`; tapping it does nothing (no `desktop=preview`); the Pane actions row reads **Reconnecting…**, disabled. Header row height stays 30. Relay back within 20 s → chip returns live, no second tooltip |
| 3 | Drop outlasts the reconnect window: stale chip removed; a vouched channel brings it back | **PASS**. Dim at 06:41:19.0 → removed at 06:41:39.8 (20.7 s); relay back → channel retries to live → chip back with its dot, no tooltip (same `since`) |
| 4 | No preview metadata from the host: header reserves nothing and announces nothing | **PASS**. With no presence there is no chip node and the header row is 30 px, the same as with the chip. Browser closed → window gone 06:33:04.27 → chip gone 06:33:07.65 (3.4 s; the host withdraws after 3 s) |
| 5 | Rendered chip and tooltip look right on a phone viewport | **PASS**. An independent screenshot review found no defects: the caret points at the chip's centre; nothing overlaps or clips at 270 or 393; the header title and 30 px row height don't move; the dot and the Watch pill read clearly. At 270 dp the workspace subtitle abbreviates while the chip is labelled, and comes back at rest. Tooltip is 252 px wide and clamped inside 8 px at 270 dp (x 10–262); the chip grows its label to 88 px while the tooltip is up and rests at 39 px; the terminal never re-attached when the chip appeared (host attach count unchanged, 10 → 10) |

### Bug found (outside this PR): an agent state change wipes the chip
With the browser still open, any `session.updated` that the host forwards from Herdr drops `preview`. That includes the agent going Working or idle, which happens on every prompt. The phone then removes the chip until the next presence push or a reload.
- Repro: chip live → send the agent "reply ok" → the chip is gone 0.7 s later while the window stays mapped (`06-bug-before.png` → `06-bug-after.png`). A page reload brings the chip back, because `session.list` still carries it.
- Cause: `forward()` in `apps/host/src/host.ts` broadcasts source events as they are. Only `pushPresence` and the snapshots go through `withPreview` (from #533).
- Fix: pass the `session` of `session.created` and `session.updated` through `withPreview(..., previewForPane)` in `forward()`. That is about 3 lines, host only.
- Effect in real use: an agent that opens a browser mid-turn loses the chip when its turn ends. This is exactly the first scenario the owner cares about.

### Other observations (not from this PR)
- The first terminal attach after a page load or a viewport change was often refused ("link refused the pane stream"). **Reconnect terminal** always fixed it. While the channel is down the chip correctly shows dimmed, so this never produced a wrong chip.
- Native iOS was not driven here (no iOS device in the lab). The chip is gated by `Platform.OS !== 'ios'` in `TerminalScreen.tsx`.

### Captures (before → after)

| Scenario | Before | After |
|---|---|---|
| 1 · browser opens (393) | <img src="https://github.com/umeranjum17/muxr/blob/qa/pr-531-live-evidence/pr-531/04-393-before.png?raw=true" width="180" alt="04-393-before"> | <img src="https://github.com/umeranjum17/muxr/blob/qa/pr-531-live-evidence/pr-531/05-393-tooltip.png?raw=true" width="180" alt="05-393-tooltip"> <img src="https://github.com/umeranjum17/muxr/blob/qa/pr-531-live-evidence/pr-531/05-393-rest.png?raw=true" width="180" alt="05-393-rest"> |
| 1 · Watch → live view · Pane actions | <img src="https://github.com/umeranjum17/muxr/blob/qa/pr-531-live-evidence/pr-531/05-393-rest.png?raw=true" width="180" alt="05-393-rest"> | <img src="https://github.com/umeranjum17/muxr/blob/qa/pr-531-live-evidence/pr-531/01-watch-live-view-animated.png?raw=true" width="180" alt="01-watch-live-view-animated"> <img src="https://github.com/umeranjum17/muxr/blob/qa/pr-531-live-evidence/pr-531/01-pane-actions-row.png?raw=true" width="180" alt="01-pane-actions-row"> |
| 2 · link drops | <img src="https://github.com/umeranjum17/muxr/blob/qa/pr-531-live-evidence/pr-531/02-before.png?raw=true" width="180" alt="02-before"> | <img src="https://github.com/umeranjum17/muxr/blob/qa/pr-531-live-evidence/pr-531/02-after-drop.png?raw=true" width="180" alt="02-after-drop"> <img src="https://github.com/umeranjum17/muxr/blob/qa/pr-531-live-evidence/pr-531/02-pane-actions-reconnecting.png?raw=true" width="180" alt="02-pane-actions-reconnecting"> <img src="https://github.com/umeranjum17/muxr/blob/qa/pr-531-live-evidence/pr-531/02-recovered.png?raw=true" width="180" alt="02-recovered"> |
| 3 · drop > 20 s | <img src="https://github.com/umeranjum17/muxr/blob/qa/pr-531-live-evidence/pr-531/03-dimmed-8s.png?raw=true" width="180" alt="03-dimmed-8s"> | <img src="https://github.com/umeranjum17/muxr/blob/qa/pr-531-live-evidence/pr-531/03-after-25s.png?raw=true" width="180" alt="03-after-25s"> <img src="https://github.com/umeranjum17/muxr/blob/qa/pr-531-live-evidence/pr-531/03-recovered.png?raw=true" width="180" alt="03-recovered"> |
| 4/5 · 270×594 reference viewport | <img src="https://github.com/umeranjum17/muxr/blob/qa/pr-531-live-evidence/pr-531/04-270-dark-before.png?raw=true" width="150" alt="04-270-dark-before"> | <img src="https://github.com/umeranjum17/muxr/blob/qa/pr-531-live-evidence/pr-531/05-270-dark-tooltip.png?raw=true" width="150" alt="05-270-dark-tooltip"> <img src="https://github.com/umeranjum17/muxr/blob/qa/pr-531-live-evidence/pr-531/05-270-dark-rest.png?raw=true" width="150" alt="05-270-dark-rest"> |
| Bug · agent state change | <img src="https://github.com/umeranjum17/muxr/blob/qa/pr-531-live-evidence/pr-531/06-bug-before.png?raw=true" width="180" alt="06-bug-before"> | <img src="https://github.com/umeranjum17/muxr/blob/qa/pr-531-live-evidence/pr-531/06-bug-after.png?raw=true" width="180" alt="06-bug-after"> |

Raw per-capture state (chip label/disabled/opacity/dot, tooltip rect, header row height), the ~1 s phone timeline and the 250 ms pane-window log: https://github.com/umeranjum17/muxr/tree/qa/pr-531-live-evidence/pr-531

