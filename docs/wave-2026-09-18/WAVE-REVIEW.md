# 🌊 Wave 2026-09-18 — Full Product Review

**25 PRs in this review, all merged · full wave since it opened: 31 PRs, 260 files, +10,053 / −8,708 · 84 screenshots · every screen walked on web and native Android**

---

## ✅ ALL 25 MERGED PRs

| # | Title | Proof |
|---|-------|-------|
| [#329](https://github.com/umeranjum17/muxr/pull/329) | Per-agent slash command catalogue | SLASH screenshots below |
| [#330](https://github.com/umeranjum17/muxr/pull/330) | Slash rows not cards, bottom sheet | SLASH screenshots below |
| [#331](https://github.com/umeranjum17/muxr/pull/331) | Home on design spine | HOME screenshots below |
| [#332](https://github.com/umeranjum17/muxr/pull/332) | Layer alignment part 2 | Typecheck + architecture green |
| [#333](https://github.com/umeranjum17/muxr/pull/333) | Dictation settings regrouped | DICT screenshots below |
| [#334](https://github.com/umeranjum17/muxr/pull/334) | False-green check killed, fast CI lane | CI minutes, not tens of minutes |
| [#335](https://github.com/umeranjum17/muxr/pull/335) | Finished-unseen tier on Home | HOME screenshots below |
| [#337](https://github.com/umeranjum17/muxr/pull/337) | 15 perf tests revived | They execute in the suite |
| [#338](https://github.com/umeranjum17/muxr/pull/338) | Browser states + status line | BROWSER screenshots below |
| [#339](https://github.com/umeranjum17/muxr/pull/339) | Legacy phone-side graphics subsystem removed | 59 files, −6,192 lines; the banner can never appear |
| [#340](https://github.com/umeranjum17/muxr/pull/340) | Command palette fixes | PALETTE screenshot below |
| [#341](https://github.com/umeranjum17/muxr/pull/341) | Right Now card (plan limits + vitals) | USAGE screenshots below |
| [#342](https://github.com/umeranjum17/muxr/pull/342) | Slash row full-row tap target | Fixes #340 regression |
| [#343](https://github.com/umeranjum17/muxr/pull/343) | Spaces grouping (parents + children) | HOME screenshots below |
| [#344](https://github.com/umeranjum17/muxr/pull/344) | Editable key row (add/remove/reorder/custom) | KEYROW screenshots below |
| [#345](https://github.com/umeranjum17/muxr/pull/345) | Brittle test anchor → structural | Prose edits can't break tests |
| [#346](https://github.com/umeranjum17/muxr/pull/346) | 15 perf tests genuinely run | 0 skipped, loud skip proven |
| [#347](https://github.com/umeranjum17/muxr/pull/347) | Voice errors in plain words | No more raw JSON |
| [#348](https://github.com/umeranjum17/muxr/pull/348) | Orb measurement fix | Verified 4 sizes × 2 font scales |
| [#349](https://github.com/umeranjum17/muxr/pull/349) | Plugin opt-in marker | No accidental capture |
| [#350](https://github.com/umeranjum17/muxr/pull/350) | Charts caption a11y | Plain text, not heading |
| [#351](https://github.com/umeranjum17/muxr/pull/351) | Inline image display in terminal | IMAGE proof below |
| [#353](https://github.com/umeranjum17/muxr/pull/353) | Spaces rail-and-chips | Rail, chips, collapsed header — SPACES-RAIL below |
| [#355](https://github.com/umeranjum17/muxr/pull/355) | QR onboarding — scan to pair | End-to-end check: 841/841 QR modules match |
| [#356](https://github.com/umeranjum17/muxr/pull/356) | Keystroke latency: TCP_NODELAY, microbatching, local echo | Research + fix below |

---

## 🆕 PROVED AFTER THE REVIEW OPENED

The first cut of this review listed four lanes as still running. They all landed. This is the evidence.

### Lavish dashboard — browser takeover on web PWA and native Android

The Lavish review board renders live (client-side clock) inside muxr's browser takeover view, once on the web PWA and once on the native Android app.

![Lavish board on web PWA](screenshots/LAVISH-01-web-pwa.png)
![Lavish board on native Android](screenshots/LAVISH-02-native-android.png)

### Spaces — final rail-and-chips grouping

Connector rail with elbows into child dots, needs-you / working chips, collapsed-header chip, dark tokens, 360–432 dp, web and device.

![Web 360 collapsed](screenshots/SPACES-RAIL-01-web-360-collapsed.png)
![Web 360 expanded](screenshots/SPACES-RAIL-02-web-360-expanded.png)
![Web 430 expanded](screenshots/SPACES-RAIL-03-web-430-expanded.png)
![Web 430 collapsed](screenshots/SPACES-RAIL-04-web-430-collapsed.png)
![Web 430 dark](screenshots/SPACES-RAIL-05-web-430-dark.png)
![Device 360 collapsed](screenshots/SPACES-RAIL-06-device-360-collapsed.png)
![Device 360 expanded](screenshots/SPACES-RAIL-07-device-360-expanded.png)
![Device 432 mixed](screenshots/SPACES-RAIL-08-device-432-mixed.png)

### Inline terminal image rendering

`muxr show-image` pushes an image to the phone, where it renders as an elevated card over the terminal — before and after in one real pane.

![Terminal before the image arrives](screenshots/IMAGE-01-terminal-before.png)
![Image rendered inline over the terminal](screenshots/IMAGE-02-image-inline.png)

### Provider-agnostic naming across four providers

One naming pipeline names agent panes after their task, whatever provider runs behind the pane. Four providers — including a model-hosted one — get the same task-derived names on Home, in tabs, and in the pane header; an agent that fails (expired credentials) keeps its name.

![Home listing agents from four providers with uniform task names](screenshots/NAMING-01-home-four-providers.png)
![A failing agent still carries its task name; four provider tabs](screenshots/NAMING-02-failing-agent-still-named.png)
![The same naming on the fourth provider; model id in the status line](screenshots/NAMING-03-named-across-stacks.png)

### Floating action controls — shipped vs approved mocks

The movable command puck docks mid-right over the terminal exactly as the approved surface mock draws it; tapping it opens the quick-actions sheet.

![Approved surface mock, light and dark](screenshots/MOCK-01-approved-surfaces.png)
![Puck docked over the terminal](screenshots/PUCK-01-docked.png)
![Quick-actions sheet open](screenshots/PALETTE-01-panel-open.png)

### SSH/QR onboarding

Onboarding is: reach the computer over SSH (or sit at it), run `muxr pair`, scan the centered terminal QR with the phone, confirm consent. The pair ceremony prints its own security disclosure, the QR is centered in the terminal, and an end-to-end check decodes all 841/841 QR modules and completes the exact claim path the phone uses (one-time code → sealed grant → claim → verified device). Replay is refused.

![CLI config flow: muxr pair ceremony with disclosure through "paired and verified"](screenshots/CLI-01-config-flow.png)
![Android first run](screenshots/ANDROID-01-first-run.png)
![Pair screen: scan the QR shown by muxr pair](screenshots/ANDROID-02-pair-screen.png)
![Pair consent: what the phone will be able to do and how it is secured](screenshots/ANDROID-03-pair-consent.png)

---

## 📱 SCREENSHOTS — the product after all merges

### Terminal — live, scrolling, jump-to-latest

![Terminal live attach](screenshots/TERM-01-live-attach.png)
![Terminal scrolled](screenshots/TERM-02-scrolled-jump-control.png)
![Terminal latest pill](screenshots/TERM-04-latest-pill.png)

### Home — design spine, finished-unseen tier, Right Now card

![Home ready-unseen + right-now](screenshots/HOME-01-ready-unseen-right-now.png)
![Home right-now card](screenshots/HOME-04-right-now-card.png)
![Home right-now full](screenshots/HOME-05-right-now-card-full.png)
![Home disconnected](screenshots/HOME-03-disconnected.png)

### Spaces — grouped

![Spaces grouped](screenshots/HOME-06-home-spaces.png)
![Spaces bottom](screenshots/HOME-02-spaces-bottom.png)

### Browser — real states

![Browser not opened](screenshots/BROWSER-01-not-opened.png)
![Browser details expanded](screenshots/BROWSER-03-details-expanded.png)
![Browser native takeover](screenshots/BROWSER-04-native-takeover.png)
![Browser native after open](screenshots/BROWSER-06-native-after-open.png)

### Slash catalogue — rows, destructive confirms

![Slash catalogue](screenshots/SLASH-01-catalogue.png)
![Slash destructive](screenshots/SLASH-02-catalogue-destructive.png)
![Slash native](screenshots/SLASH-03-native-catalogue.png)
![Slash native destructive](screenshots/SLASH-04-native-destructive.png)

### Key row — fully editable

![Editor](screenshots/KEYROW-01-editor.png)
![Add key catalogue](screenshots/KEYROW-02-add-key-catalogue.png)
![Custom key added](screenshots/KEYROW-03-custom-added.png)
![Row with custom](screenshots/KEYROW-04-row-with-custom.png)
![Native editor](screenshots/KEYROW-05-native-editor.png)

### Usage — normalized provider windows and plan limits

Every provider renders into the same windows card; providers with plans show plan state ("Nearly out"), others fall straight to Today / 7-day.

![Usage empty](screenshots/USAGE-01-right-now-empty.png)
![Provider windows](screenshots/USAGE-02-provider-windows.png)
![Plan card, nearly out](screenshots/USAGE-03-plan-card-nearly-out.png)
![Provider windows, alternate set](screenshots/USAGE-04-provider-windows-alt.png)
![Provider windows, second set](screenshots/USAGE-05-provider-windows-2.png)
![Today and 7-day](screenshots/USAGE-06-today-and-week.png)
![Today and 7-day, second provider](screenshots/USAGE-07-today-and-week-2.png)
![Usage native](screenshots/USAGE-08-native.png)

### Dictation — regrouped settings

![Dictation settings](screenshots/DICT-01-voice-settings.png)
![Language picker](screenshots/DICT-02-language-picker.png)
![Word replacement](screenshots/DICT-04-word-replacement-form.png)
![Word saved](screenshots/DICT-05-word-replacement-saved.png)
![Native dictation](screenshots/DICT-07-native-dictation.png)
![Native model download](screenshots/DICT-08-model-download.png)

### Connection

![Connection first-run](screenshots/CONN-01-first-run-account-landing.png)
![Connection settings](screenshots/CONN-02-connection-settings-dev.png)
![Native version mismatch](screenshots/CONN-04-native-mismatch.png)
![Native versions](screenshots/CONN-05-native-versions.png)

### Plugins + settings + what's new + history + new agent

![Plugins](screenshots/PLUGINS-01-list.png)
![Settings index](screenshots/SETTINGS-01-index.png)
![What's New](screenshots/WHATSNEW-01.png)
![Pane scrollback](screenshots/HISTORY-01-pane-scrollback.png)
![New agent native](screenshots/NEWAGENT-01-native.png)

---

## 📊 RESEARCH FINDINGS — 5 scouts, converging conclusions

Summaries only; the full reports stay in the wave workspace, out of this repository.

- **Keystroke latency budget.** Measured 33 ms keypress-to-pixels; 28 ms of it was the React Native frame scheduler (rAF pump gate 13 ms + vsync 15 ms). Network is essentially free (2 ms phone→PTY, 1 ms workspace echo, ~0 ms relay). **Shipped as #356:** TCP_NODELAY on all sockets, keystroke microbatching, dimmed local echo prediction.
- **A mature on-device Android terminal draws immediately** with zero framework overhead — the benchmark the latency work closes on.
- **A competing mobile terminal is smooth because it is not a terminal**: text overlay instead of terminal rendering, ~360 ms echo, 1.5–6 s output quantization. Our approach is architecturally harder but renders the real thing; the fix belongs in the pipeline, not in replacing it.
- **Spaces grouping needed declared lineage, not new phone code**: task workspaces lacked parent/kind metadata; the producer now declares it at creation.
- **OSS mobile SSH survey (6 stacks).** Most transferable techniques: snapshot-keyframe resumption with sequence numbers, consumer-pull bounded tap with load shedding, immutable snapshots + damage union at the bridge.

---

## 📋 STILL OPEN — tracked, not blocking

| Item | What's needed |
|------|---------------|
| [#336](https://github.com/umeranjum17/muxr/pull/336) CI manual-dispatch | Remove `suite` from branch protection |
| 8 design docs | Captain review (in the wave workspace) |

---

**This PR is the complete record of the wave. Close after review; the release pipeline runs after.**
