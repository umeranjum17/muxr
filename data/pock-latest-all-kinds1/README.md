# Latest across terminal kinds

Codex **fails on current main**, on both PWA and Android. This is not only an old-client or Claude issue. pi also fails while output streams; Claude's existing fixes pass these runs.

Baseline: `origin/main` at `3d1c6ef85b8847682c49e8e3117696fbd19b0db2`. Earlier candidate (before host bottom completion): the three source hashes in [candidate.sha256](candidate.sha256). Captured 2026-09-30. No agent-name condition was added.

## Earlier candidate results

Each cell covers **slow drag and fling**, then tapping Latest. “Stopped” means an answer finished before scrolling; “streaming” means scrolling started after actual numbered answer text appeared and output continued during the gestures. Pass requires reaching the current live viewport; a previous answer's end marker alone does not count.

| Kind | Main PWA stopped | Main PWA streaming | Main Android stopped | Main Android streaming | Final PWA stopped / streaming | Final Android stopped / streaming |
| --- | --- | --- | --- | --- | --- | --- |
| Codex 0.159.2, default screen mode | Fail | Fail | Fail | Fail | Pass / Pass | Pass / Pass |
| pi 0.87.0 | Pass | Fail | Pass | Fail | Pass / Pass | Pass / Pass |
| Claude Code 2.1.285 | Pass | Pass | Pass | Pass | Pass / Pass | Pass / Pass |
| Plain shell | Pass | Fail | — | — | Pass / Pass | — |

Codex owns its transcript: Herdr's zero scroll offset alone does not establish success. On main it remains on earlier answer text and displays `Back to bottom` or `New activity · ↓ Bottom` after Latest. Final stopped captures show the answer's end; final streaming captures show the current partial answer with those indicators gone. pi and shell expose Herdr-owned scrollback: main streaming Latest leaves positive offsets (pi PWA 19/15 rows, shell 104/91); final offsets are zero. Native pi remains 256 rows back after the baseline stream finishes, whereas the final live run reports zero after both gestures.

The initial native Codex scratch classifier recognized only `Back to bottom` and incorrectly classified `New activity · ↓ Bottom` as success. Published result files are corrected against the raw captures; see [interpretation](codex-native-main-interpretation.txt). Early native runs interrupted by Android settings/permission UI and intermediate coordinate-only candidates are excluded. Final-named captures run the earlier coordinate and finite-allowance fixes together; they do not qualify this review revision.

## Captures

All published PNGs are screenshots after Latest. Native screenshots are reduced to 600 px width; PWA screenshots retain their 393 × 780 viewport. The adjacent `*-up.txt` and `*-latest.txt` files record the real pane before and after Latest. `*-result.json` records both gestures. `*-state.json` contains only terminal scroll state, with harness session metadata omitted.

| Kind / client | Main evidence | Final stopped | Final streaming |
| --- | --- | --- | --- |
| Codex PWA | [Stopped failure](codex-pwa-latest-main-repeat.png), [streaming failure](codex-pwa-main-streaming-fling-latest.png) | [Latest](codex-pwa-final-idle-fling-latest.png) | [Live Latest](codex-pwa-final-streaming-fling-latest.png) |
| Codex Android | [Stopped failure](codex-native-main-idle-fling-latest.png), [streaming failure](codex-native-main-streaming-fling-latest.png) | [Latest](codex-native-final-idle-fling-latest.png) | [Live Latest](codex-native-final-streaming-fling-latest.png) |
| pi PWA | [Streaming failure](pi-pwa-main-streaming-fling-latest.png) | [Latest](pi-pwa-final-idle-fling-latest.png) | [Live Latest](pi-pwa-final-streaming-fling-latest.png) |
| pi Android | [Streaming failure](pi-native-main-streaming-fling-latest.png), [parked final state](pi-native-main-streaming-final-state.json) | [Latest](pi-native-final-idle-fling-latest.png) | [Live Latest](pi-native-final-streaming-fling-latest.png) |
| Claude PWA | [Stopped](claude-pwa-main-idle-fling-latest.png), [streaming](claude-pwa-main-streaming-fling-latest.png) | [Latest](claude-pwa-final-idle-fling-latest.png) | [Live Latest](claude-pwa-final-streaming-fling-latest.png) |
| Claude Android | [Stopped](claude-native-main-idle-fling-latest.png), [streaming](claude-native-main-streaming-fling-latest.png) | [Latest](claude-native-final-idle-fling-latest.png) | [Live Latest](claude-native-final-streaming-fling-latest.png) |
| Shell PWA | [Streaming failure](shell-pwa-main-streaming-fling-latest.png) | [Latest](shell-pwa-final-idle-fling-latest.png) | [Live Latest](shell-pwa-final-streaming-fling-latest.png) |

Slow-drag captures use the same names with `slow` in place of `fling`. Baseline Codex PWA stopped failure was captured separately; the two-gesture streaming comparison and native stopped comparison reproduce it independently.

## Shared cause and change

Latest must address the live transcript in the terminal's actual scrolling model. Two shared gaps appeared in that path:

1. Main's Latest sends no pointer cell, while drag/fling do. A program may ignore wheel reports targeted at its header/footer. The earlier candidate's phone-side center fallback established the coordinate cause. Latest now uses the host-owned bottom operation, whose program-owned wheel reports target the current grid's center. Gesture scroll requests carry explicit view-selected coordinates; the superseded pointerless phone fallback and its assertions have been removed. The current bottom protocol requires the updated host.
2. The finite 2,000-row allowance in the earlier candidate still fails if a larger burst arrives before the request is handled. The replacement bottom operation's contract and limits are documented in [the terminal wire contract](../../packages/contract/src/control-plane/infrastructure/terminal.ts); user-facing controls and feedback are described in [the product README](../../README.md#a-real-terminal-built-for-thumbs).

Latest during an active fling: each terminal view now discards its preceding gesture before sending the bottom request. Web cancels pending scroll and momentum frames and clears accumulated travel; native resets its scroll gate and ignores old fling callbacks until the next touch. New gestures still travel to the host and cancel bottom completion. The existing rendered web/native flows now exercise Latest while momentum or gated travel is still pending, followed by a new gesture. Focused rendered-view verification: both extended flows fail against the starting view code ([red](r2-motion-red.log)) and pass against this revision ([green](r2-motion-green.log)), including a fresh gesture after Latest. Vitest 4.1.11 ran only those two files with temporary local React/test-renderer dependencies and isolated mocked-platform resolution; no full suite or real lab run was performed. The outer executor owns fresh per-kind lab qualification; earlier captures do not qualify this revision.

The hosted-channel flow covers input cancellation, resize, stale replies across requests, retained cannot-finish feedback and repaint. Focused Vitest 4.1.11 verification passed the hosted-channel flow and the existing kit-backed host burst flow ([green](r4-status-green.log)); the extended client flow failed against the starting channel code ([red](r4-status-red.log)). Temporary worktree-local dependencies and isolated configuration were used; the host flow was extracted unchanged from its existing integration file to avoid loading unrelated suites. Earlier captures remain scoped to their original candidates; fresh lab qualification belongs to the outer executor.

Byokit ask: expose a pane scroll-offset reset through `@byokit/herdr`. The pinned 0.1.2 public kit API has no reset operation. This revision uses its existing terminal stream and pane-read boundary, with no additional raw Herdr adapter.

Review revision qualification: the focused burst regression passed on this revision and failed on the starting host code with `Latest completion timed out`. It was executed from the existing integration test body using TypeScript transpilation, Node assertions, the pinned kit, and the real TerminalManager; the full Vitest lane was not run in this dependency-free worktree. `git diff --check` passed. The new bottom protocol requires the updated host. The burst regression exercises the real TerminalManager and kit terminal subprocess with a simulated pane: the phone sees 100, 2,500 more rows arrive before the first downward request is applied, and host completion must end at zero. Per-kind native/PWA reruns belong to the outer validation phase and have not been run for this revision. The captures and suite logs below qualify only the earlier candidate hashes.

The prior Claude changes ([wheel pacing](https://github.com/umeranjum17/muxr/pull/542), [Latest reach](https://github.com/umeranjum17/muxr/pull/553)) are present in this baseline. These new changes use the shared terminal channel and the existing actual scroll-state distinction, rather than the provider name.

## Lab and verification

Used `fm-herdr-lab.sh` with isolated XDG and explicit named non-default session `fm-lab-lk-453939-31274` on every Herdr call. Source host state was private to the worktree; Metro/relay/download ports were 21881/21892/21893. Both clients paired with the development host through the ordinary link-grant flow. No owner-secret injection, production home, phone, or fleet pane was used.

The own AVD used Android 36/google APIs/x86_64, serial `emulator-5592`, 1080 × 2376 at density 640 (270 × 594 dp). The installed development APK was version 0.2.0/runtime 2; its application bundle came from the current Metro source, not the packaged JavaScript. Native baseline/final comparisons cold-reloaded the development client when changing candidate. PWA gestures used TouchEvents through the actual terminal handlers; native used adb slow swipes (1,400 ms) and flings (80 ms). These are emulator/browser results, not a physical-phone qualification.

Agents were real interactive panes producing 180 numbered lines without tools or edits. Output waits matched actual answer prefixes, not the thinking phase. The shell streamed 600 lines at 50 ms intervals. Each client used its real terminal subscription and host bridge.

The earlier hosted terminal flow covered gesture coordinates and the former pointerless Latest after resize ([red](test-red.log), [green](test-green.log)). These logs qualify that earlier candidate only. The current flow retains explicit gesture-coordinate coverage; the obsolete pointerless Latest assertions have been removed. After that removal, focused Vitest 4.1.11 verification of `OpenTerminal.hosted.spec.ts` passed (one flow), using temporary worktree-local test dependencies and the real contract source. This does not qualify the pending per-kind lab rerun. No new test file or provider-mocked test matrix was added. Those earlier pi/shell comparisons cover the observed smaller bursts, not the unbounded stale-offset invariant.

`yarn run check:fast`: **15/15 passed**, exit 0 ([log](check-fast.log)). Main and coordinate candidate mobile typechecks both exited zero. Final source hashes were rechecked after the suite and all final captures; `git diff --check` passed.

Cleanup signaled only the exact source-stack and emulator PIDs started by this task, stopped the owned browser session, and tore down the named Herdr lab through its guarded helper. The helper verified the fleet-default tripwire; approved short temporary directories were removed. Pairing offers, agent metadata, AVD disks, runtime state and intermediate captures remain outside this published evidence set.
