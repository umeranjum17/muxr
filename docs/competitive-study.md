# Competitive study — Moshi and Collie

What two adjacent products do better than muxr, what muxr should adapt, and how
their onboarding compares to ours.

**This document recommends. It does not authorize.** Nothing here is accepted
product direction. Anything that changes workflow, onboarding, a default or a
vocabulary is T2, and anything touching pairing or authority is T3 — see
[decisions/README.md](decisions/README.md). Pick from this list; do not treat it
as a backlog.

## Evidence basis

The competitor half rests on a device-backed audit run on 2026-09-13: Android
test phone (OnePlus, Android 16, 1080×2376), **Moshi 3.14.0** from Play with
`moshi-hook 0.3.22` on Linux, **Collie v1.8.2** PWA installed to the home
screen, against **muxr 0.1.28** (build 54) on host 0.1.29-nightly. Every
competitor screen cited was a real tap on that phone or a real command on a
Linux host — 60 screenshots and 19 host-side text captures. Filenames are cited
inline as `[moshi-06]`.

The muxr half of this study was re-derived from the source tree in this
repository, not from memory or from the audit's summary of us. Where reading the
code contradicted the audit, the code wins and the correction is marked.

Claims are labelled:

- **Observed** — someone saw this happen on a device, or it is in the code at a
  cited path.
- **Inferred** — a reasonable reading of observed behaviour, not directly seen.
- **Judgement** — an opinion about what muxr should do. Arguable by design.

---

## 1. What the two products are

**Moshi** is a commercial iOS/Android terminal client. The phone is a real SSH
client: it holds an ed25519 private key in device secure storage and speaks
SSH/Mosh directly to the host, with no desktop in the middle. Transport is an
`Auto → Mosh → ET → SSH` ladder. A separate daemon (`moshi-hook`) is a *side
channel* for agent approvals, diff and web preview — the terminal works with the
daemon fully stopped. It has a paid tier (Pro), a license key, and a usage-aware
paywall. *(Observed: `[moshi-20]`, `[moshi-08]`, `[moshi-13]`, `[moshi-24]`,
`[moshi-set-pro]`.)*

**Collie** is the herdr PWA (`AltanS/collie`, `colliepwa.dev`) — an open-source
web client served by a host-side bridge, installed to the home screen. The
phone types nothing during setup: every decision is made on the host before the
phone is ever opened. It polls a TUI mirror rather than rendering a live
terminal. *(Observed: `[collie-06]`, `[collie-08]`, `[collie-host-01..04]`.)*

Both overlap muxr on the core promise — your agents, on your phone — and
neither is a clone of it.

---

## 2. Moshi — what it does, with evidence

### 2.1 Failure copy names the fix, at the point of failure

The single most valuable thing Moshi does. When the hook daemon is unreachable,
the error card reads "Could not reach the hook on this host. Retry" and directly
beneath it sits the exact restart command, behind a **macOS/Linux toggle** with
a **Copy** button. You never leave the error to find out what to type.
*(Observed: `[moshi-13]`, `[moshi-14]`.)*

The same pattern appears wherever Moshi asks you to do something on the
computer: host commands are always OS-tabbed and always copyable.

### 2.2 Choices are labelled with their cost

The connect fork tags each route with time and prerequisites — "~1 min ·
Recommended" for Easy Pair versus "~3 min · needs hostname + key" for
bring-your-own-SSH. A reader picks correctly without opening docs.
*(Observed: `[moshi-02]`.)*

### 2.3 "What happens" before you run anything

Before showing the host command, Moshi shows a 1-2-3 of the handshake it is
about to perform. *(Observed: `[moshi-04]`.)*

### 2.4 Setup echoes the settled config and names the file

After the first-run multi-select, the installer prints back what you chose and
where it lives:

```
always-on-discovery: on
usage-collection: on
suppress-nested-agent-push: off
config: /home/umer/.config/moshi/config.toml
```

The CLI also states explicitly that hand-editing the file is equivalent to the
`set` command and that comments and unknown keys are preserved — which removes
the "will this tool clobber my file?" fear. The model is clean: **persistent
preferences are file-or-command; actions are command-only**. *(Observed:
`[moshi-host-01]`, `[moshi-host-02]`.)*

### 2.5 Feature discovery that routes you to the setting

A "Discover Moshi" gallery lists 14 power features; each tile is icon + name +
**a breadcrumb to where it lives** ("SETTINGS → DICTATION"), turns green when
done, and deep-links to that exact setting. The home empty state carries a
matching "DISCOVER MOSHI 8/18" progress bar with tappable chips. *(Observed:
`[moshi-set-discover]`, `[moshi-set-discover-tile]`.)*

### 2.6 Agent-aware surfaces

Moshi knows which harness is in the pane and adapts: a per-agent shortcut
library (Claude 8 / Codex 34 / Cursor 24 / Copilot 18 / Herdr …) and an "Agents
Supported" mark row on feature screens. *(Observed: `[moshi-set-shortcuts]`.)*

### 2.7 Settings rows teach, and unavailable rows say why

Nearly every row is icon + title + one-line description + control. Dependent
settings are shown **disabled with a reason** rather than hidden — "Start in
Chat View" is greyed until "Show as Chat" is on; Files/Web Servers/Simulators
rows read "stay hidden until a paired host is running one". Screens that touch
data carry a plain-language footer ("messages travel host↔app over the encrypted
SSH channel and never pass through Moshi's servers"). *(Observed:
`[moshi-set-showonhome]`, owner tab capture `30243`.)*

### 2.8 A dictation engine picker with stated tradeoffs

Four engines (Whisper / Parakeet-EXPERIMENT / Cloud / BYOK-PRO), each with a
one-line tradeoff, a model-size picker showing MB and accuracy, and an in-place
"test transcription". *(Observed: `[moshi-set-speech]`.)*

The test-transcription flow itself is a batch pipeline with three states —
Recording (red animated 5-bar waveform) → Transcribing (bars desaturate to grey,
teal spinner, latency shown) → Result (card slides up and fades in, ~500 ms
ease-out). State swaps are hard cuts in a single frame (<33 ms); the only eased
transition is the result card. The whole transcript lands at once; there are no
live partials on this path. *(Observed, frame-by-frame at 30 fps from a screen
recording.)*

### 2.9 Where SSH costs Moshi

With the network dropped mid-session, a plain-SSH connection returned
"Connection failed: SSH connect timed out after 20s" and did **not** resume —
SSH has no session resumption, so a dropped TCP connection is a dead session.
This is why Moshi pushes Mosh so hard and treats `mosh-server` as a
prerequisite; Mosh in turn needs UDP 60000–61000 open, which is its own
firewall chore. *(Observed: `[moshi-18]`.)*

---

## 3. Collie — what it does, with evidence

### 3.1 Zero phone-side onboarding

Collie has no onboarding flow at all. The first screen is the live herd, already
useful: "Nothing needs you", WORKING(3), RECENT(5), real agents. Opening the URL
*is* the value. *(Observed: `[collie-06]`.)*

This is the cheapest onboarding of the three **because Collie moved the entire
cost onto a host operator who has a keyboard** — not because it solved
onboarding. *(Judgement.)*

### 3.2 A triage home with an unseen/seen split

Three honest groups — **READY·UNSEEN / WORKING / RECENT** — where READY·UNSEEN
means "finished, but you haven't looked yet". Every row shows harness icon, cwd,
task, state and age. *(Observed: `[collie-set-00-home]`.)*

### 3.3 An agent-aware, searchable command palette

The palette reads the pane's harness ("claude · 51 commands"), is searchable,
and each row carries placeholder args (`[model]`), a description, and two
actions: ↵ send-now versus ✎ edit-args. *(Observed: `[collie-sheet-agent]`.)*

### 3.4 Every settings row states its *why*

One flat settings page where each row carries a reason — including the iOS-zoom
rationale for the 16px draft-text floor. Security posture is stated in words:
"Nothing is paired, so writes are ungated. Pair a device to require a
credential." *(Observed: `[collie-set-settings-top]`.)*

### 3.5 Diagnostics as inspectable values

A Connection block showing Endpoint, Secure context: Yes, Bridge: Connected,
Device access: Not enforced, and **Server build `78f74d1 · 2026-09-12 21:47
UTC`**. *(Observed: `[collie-set-settings-top]`.)*

### 3.6 An installer that explains itself before you pipe it

`install.sh` opens with a comment stating what it will and will never do — no
sudo, no service, sends nothing — and **ends by printing the three remaining
steps rather than performing them**. *(Observed: `[collie-host-01]`.)*

### 3.7 Config docs that live next to the installer

`.env.example` carries 41 keys, each with a paragraph explaining *why*,
including socket-length and multi-instance warnings. The installer and this file
*are* the config documentation. *(Observed: `[collie-host-02]`.)*

### 3.8 Two pane actions muxr lacks

The pane menu offers **Find in output** (search the scrollback) and **Focus in
herdr** (jump the desktop to this pane). *(Observed: `[collie-pane-actions]`.)*

---

## 4. Where muxr is genuinely behind

Each item below was re-checked against this repository. Several claims in the
source audit did **not** survive that check and are corrected in §4.6.

### 4.1 Our offline states name the symptom but not the cure

muxr's connection vocabulary is a set of bare adjectives with no remediation
attached:

```
status: { connected, connecting, disconnected,
          error: 'host not responding', offline, lastSeen, … }
```

*(Observed: `apps/mobile/sources/text/_default.ts:118`.)*

When the host bridge is down, the phone says `host not responding` and stops
there. Moshi says the same thing and then shows you the command. *(Observed:
`[moshi-13]`.)*

**Narrower than the audit claimed.** muxr *does* name commands in several error
paths — `muxr doctor` on a relay timeout
(`pairing/application/hostedE2ee.ts:300`), `muxr update` for an outdated peer
(`collaboration/application/computerCollaboration.ts:103`), and `muxr setup` /
`muxr pair` throughout the pairing errors. The habit exists; it just has not
reached the home connection status, which is the screen a user actually stares
at when things break. *(Observed.)*

### 4.2 The phone's cold screen offers no host affordance

The unpaired screen is a wordmark, "Run your agents from your phone.", "Pair
once. Every agent session on your computer, end-to-end encrypted.", then **Scan
QR to pair** / **Enter pairing string** and an E2EE footer. A user who arrives
at the phone first — before touching the computer — is told nothing about what
to run there. *(Observed: `apps/mobile/sources/app/(app)/index.tsx:85-101`.)*

Moshi's equivalent sheet shows the exact commands with an OS toggle and a Copy
button. *(Observed: `[moshi-03]`, `[moshi-04]`.)*

### 4.3 No agent-awareness anywhere in the pane

Both competitors adapt the UI to the harness in the pane — Moshi via per-agent
shortcut libraries, Collie via a per-agent command palette. muxr treats every
pane as a generic terminal and offers a free-text composer. *(Observed:
`[moshi-set-shortcuts]`, `[collie-sheet-agent]`; muxr composer in
`terminal/presentation/TerminalScreen.tsx`.)*

**This is the largest product gap in the study.** *(Judgement.)*

### 4.4 The Apply gate preselects Apply

`muxr setup` step 4 of 5 renders a reviewed plan, states "No change is made
until you choose Apply setup", then opens the select with **Apply
pre-highlighted**, not Cancel:

```js
const apply = await select('Apply this setup?', [
    { value: false, title: 'Cancel', … },
    { value: true,  title: 'Apply setup', … },
], 1);
```

*(Observed: `scripts/setup/presentation/setupWizard.mjs:605-607`; confirmed on a
real run, `[muxr-host-06]`.)*

A blind Enter applies the plan. Whether that is wrong depends on whether the
"review before you act" posture is meant to extend to the default selection —
that is a T2 call, not a bug I can assert. *(Judgement.)*

### 4.5 No feature-discovery path

A paired muxr user with no sessions sees "No active sessions" and "Open a new
terminal on your computer to start a session." *(Observed:
`apps/mobile/sources/text/_default.ts:281-285`.)* That is a correct next action,
but it teaches nothing about what else the app does. Moshi's discover gallery
routes you to each feature's exact setting. *(Observed: `[moshi-set-discover]`.)*

### 4.6 Corrections — three claimed gaps that are already closed

The source audit recommended adding per-row descriptions, section grouping, and
current-value text to muxr Settings. Reading
`apps/mobile/sources/settings/presentation/SettingsView.tsx` shows these are
largely done already:

| Claimed gap | Actual state (Observed) |
|---|---|
| "Settings rows are mostly title-only" | 19 `<Item>` rows; **16 carry a `subtitle`**. Only three do not: the show/hide-offline toggle, What's New, and EULA. |
| "Settings are flat" | Three `<ItemGroup>` sections already exist: Machines, App and plugins, Help. |
| "No current value on the row" | The `Item` component supports `detail` (right-aligned value) and **five rows already use it** — collaboration summary, lifecycle notification level, promoted notifications, iOS notifications, push state. |
| "Add commit + build timestamp" | `appConfig.buildCommitSha` is **already collected and rendered** in the copyable diagnostics block (`ConnectionSupport.tsx:38`). It is simply not on the version row. |
| "Collie shows *last seen*, muxr doesn't" | muxr has `status.lastSeen` in its own vocabulary (`_default.ts:126`). Parity. |

The honest residue is small: three rows lack a subtitle, and `detail` is applied
unevenly rather than as a rule. Grouping and value-display are **conventions we
already have and apply inconsistently**, not features we lack. *(Observed.)*

---

## 5. What is worth adapting, and why

Ranked by payoff per unit of work. Each says why it helps **muxr specifically** —
items that were only "a competitor has it" were dropped.

### Worth taking

1. **Put the host command inside the offline state.**
   When the phone shows `host not responding`, add one line and the exact
   command for that host's OS. muxr already knows the endpoint and transport,
   and already does this in four other error paths (§4.1) — this extends an
   existing habit to the screen where it matters most. Without it, a user whose
   host died has to go find a computer and guess. *(Judgement: highest-value
   item in this study.)*

2. **Label the routes in "Choose another way" with cost and prerequisites.**
   Our fork already lists five routes with one-line descriptions
   (`setupWizard.mjs:370-383`). Adding "~1 min" / "needs a stable wss:// address"
   is one string per route, and the wizard already knows which routes need extra
   input. Tailscale Serve versus Same Wi-Fi versus Your own server is exactly
   the decision a first-timer gets wrong. *(Judgement.)*

3. **Give the cold phone screen a "what to run on the computer" affordance.**
   One collapsed row on the unpaired screen showing `npm install -g
   --ignore-scripts @trymuxr/cli` then `muxr setup`, copyable. Covers the user
   who downloads the app before touching the host — currently a dead end
   (§4.2). *(Judgement.)*

4. **An agent-aware command palette in the composer.**
   The biggest capability gap (§4.3). The cheapest honest version is a static
   per-harness command list behind a "/" button — no dynamic harness
   introspection, no new protocol. This is where muxr's "every coding agent"
   positioning is currently only true at the transport layer and not in the UI.
   *(Judgement. T2 — it changes the composer's interaction model.)*

5. **Finish the two Settings conventions we already have.**
   Add `subtitle` to the three rows that lack one, and apply `detail` as a rule
   wherever a row has a current value (§4.6). This is consistency work on
   existing patterns, not new design. *(Judgement, cheap.)*

6. **State trust posture in words on the Connection screen.**
   Collie's "Nothing is paired, so writes are ungated" is one sentence that
   tells you your actual security state (§3.4). muxr's consent screen is
   stronger than either competitor's at *pairing time* (§7), but Settings never
   restates the posture afterwards. *(Judgement.)*

7. **Surface the commit SHA on the version row.**
   Already collected (§4.6); currently buried in diagnostics. Moves a
   support-relevant value from "tap Show diagnostics" to visible.
   *(Judgement, near-free.)*

8. **"Find in output" and "Focus in herdr" in the pane menu.**
   Two concrete actions from Collie (§3.8). "Focus in herdr" is a single herdr
   socket call and fits muxr's phone-and-desktop-together story better than it
   fits Collie's. *(Judgement.)*

9. **A dictation/voice engine picker with stated tradeoffs.**
   `docs/VOICE-SETUP.md` describes provider-neutral plugin composition, but the
   voice settings screen does not present adapters as a choice with tradeoffs
   the way Moshi's four-engine picker does (§2.8). *(Judgement.)*

10. **A four-line header comment on `install.sh` stating what it will and will
    never do.** Collie's costs nothing and pre-empts the "what am I piping into
    my shell?" objection (§3.6). muxr's installer already refuses sudo — it just
    does not say so up front. *(Judgement, near-free.)*

### Worth rejecting, and why

- **The Pro paywall, license keys and alternate app icons.** muxr has no paid
  tier by design; there is nothing to sell. *(Observed: `[moshi-set-pro]`,
  `[moshi-set-license]`.)*
- **The gamified "8/18 discovery" progress bar.** A discovery *gallery* that
  deep-links to settings is useful; turning feature adoption into a completion
  score is a maintenance burden that grows with every feature. Take the
  breadcrumb pattern, not the counter. *(Judgement.)*
- **Public-URL file uploads with a free quota.** Moshi uploads files and hands
  back a URL, metered at 5 free uploads. muxr's encrypted artifact model is
  stronger; adopting this would be a downgrade. *(Observed:
  `[moshi-set-filesharing]`; judgement on the comparison.)*
- **Rotate-to-zen.** Collie opens a terminal-only mode when you rotate the
  phone. Cute, niche, and real cost in a codebase that already handles rotation
  cleanly. *(Observed: `[collie-13]`.)*
- **Per-page doc stamps (updated / read-time / page N of 40).** Moshi's docs
  carry these across ~40 pages. Our doc set is deliberately small; the
  bookkeeping would cost more than it returns. *(Judgement.)*
- **Adopting SSH as a session transport.** See §6.4 — the analysis is in the
  onboarding section because that is where the tradeoff actually bites.

---

## 6. Onboarding — their patterns against ours

### 6.1 Decisions before first value

| | **Moshi** | **Collie** | **muxr** |
|---|---|---|---|
| Cold first screen | 3-card teaser carousel with a **Skip** `[moshi-01]` | The live herd, already useful `[collie-06]` | Wordmark + value line + **Scan QR** / **Enter pairing string** `[muxr-02]` |
| Decisions on the phone | 2 taps of teaser, then **1 real fork**: Easy Pair vs bring-your-own-SSH, each labelled with its time cost `[moshi-02]` | **Zero** — all decisions were made on the host | **1**: scan or paste |
| What it infers | Easy Pair infers the whole connection from the QR — host, user, port, platform — nothing typed `[moshi-05]` | Infers everything; the phone never types | Infers identity from Tailscale plus the machine key in the QR; the consent screen enumerates the grant `[muxr-05]` |
| Time to a live terminal, cold | ~90 s including host install | seconds (host already running) | ~60 s including the host wizard |

**The honest read:** muxr's phone-side onboarding is already competitive.
Moshi and muxr both put the *connection* decision on the phone; Collie removes
it by making the phone a pure viewer, which is cheaper only because a host
operator with a keyboard absorbed the cost. Our one-decision phone screen is the
same instinct as Collie's zero-decision one, and it is faster than Moshi's.
*(Judgement, from the observed table above.)*

We do not need a teaser carousel. It costs a screen for a one-time gain, and our
landing already states the value. *(Judgement.)*

### 6.2 The four onboarding patterns worth copying

**a. Cost labels on every route.** Moshi tags each connect option with time and
prerequisites (§2.2). muxr's "Choose another way" lists five routes with
descriptions but no cost:

```
● Tailscale Serve            private HTTPS · works from anywhere
○ Direct Tailscale           use the private tailnet address · does not require Serve
○ Same Wi-Fi                 works now · phone and computer must use the same trusted network
○ Temporary Cloudflare tunnel  create a temporary public HTTPS URL during Apply
○ Your own server            use an existing stable wss:// relay address
```

*(Observed: `[muxr-host-03]`, `setupWizard.mjs:370-383`.)*

The descriptions say what each route *is*; they do not say what it will *cost
you* or what you must already have. "Your own server" silently requires an
existing relay address; "Same Wi-Fi" silently stops working when you leave the
house. **Change:** append a cost/prerequisite clause to each of the five
strings.

**b. "What happens" before the host command.** Moshi explains the handshake
before you run anything (§2.3). muxr already has this content on the *phone* —
`pair.tsx` renders a numbered `PAIRING_STEPS` block titled "How it is secured",
and it is good. It is absent from the *host wizard*, where the user is at the
moment they are asked to act. **Change:** reuse the same three lines at the
wizard's pairing step. *(Observed: `apps/mobile/sources/app/(app)/pair.tsx:39-43`.)*

**c. Echo the settled configuration and name the file.** Moshi's installer
prints back the values you chose and the path they persist to (§2.4). muxr's
Apply step shows relay and web URLs but does not print the resolved values a
self-hoster will later want to change, nor the path they live at
(`~/.muxr/selfhost.json`). **Change:** print the handful of resolved values plus
their file path at the end of Apply.

Note that muxr deliberately has no user-facing config *file* for preferences —
so the transferable half of this pattern is the echo-and-name-the-path habit,
not Moshi's TOML. The env vars a self-hoster actually needs (`MUXR_RELAY_PORT`,
`MUXR_TRUST_PROXY`, `MUXR_ALLOWED_ORIGINS`) belong in
[SELF-HOSTING.md](SELF-HOSTING.md) rather than in a new config file.
*(Judgement.)*

**d. Discovery that routes to the setting.** Moshi's gallery gives each feature a
breadcrumb and a deep link (§2.5). The transferable piece for muxr is three or
four static rows on the paired-but-empty home, each deep-linking to the screen
it describes — not a progress counter. **Change:** replace the single "Open a new
terminal on your computer" line with that short list, keeping the line as the
first row. *(Judgement.)*

### 6.3 Where our onboarding is already ahead

- **The consent screen enumerates the grant.** "Read every agent terminal on
  that computer, including whatever is already on screen / Type into those
  terminals and answer approval prompts / Start, stop and restart agents —
  running as the user who launched muxr." Neither competitor spells out what
  pairing authorises this plainly. *(Observed:
  `apps/mobile/sources/app/(app)/pair.tsx:21-26`, `[muxr-05]`.)*
- **Switching machines is explained in place.** If the phone is already paired,
  the confirm screen says so and states that the previous pairing stays saved.
  *(Observed: `pair.tsx:222-229`.)*
- **A reviewed plan before any change.** Step 4 of 5 lists every change — 
  connection, herdr, plugins, integrations, browser client, ingress, services,
  and what happens to existing grants — before anything is applied. Collie
  starts and then offers `doctor`; Moshi installs without a plan. Our content is
  better than both; only the default selection is arguable (§4.4). *(Observed:
  `[muxr-host-06]`.)*
- **Pairing tickets are short-lived and single-use, and devices stay paired
  until revoked** — [ADR 0001](decisions/0001-device-pairing-lifecycle.md).
  Neither competitor documents a comparable lifecycle decision.

### 6.4 SSH — should onboarding offer it?

**What it buys them (Observed).** A user who already has SSH into a box can be
driving agents on it in about three minutes **without installing a relay or a
persistent service**. The only host-side install is the `moshi-hook` binary, and
even that is optional for a bare terminal. muxr does not offer this: our model
always wants a host-side daemon plus a relay.

**What it costs them (Observed).** No free reconnection on plain SSH — the
20-second timeout and dead session in §2.9. Mosh fixes it but adds a UDP
60000–61000 firewall requirement. Keys live on the phone. The host must run an
sshd the phone can reach.

**Where muxr already wins (Observed).** After the same forced network drop,
muxr's relay reconnected with no user action `[muxr-10 → muxr-11]`, because the
relay holds the session and the phone re-attaches. Collie behaves the same way.
Moshi's plain-SSH path does not.

**Judgement.** For muxr's actual users — on Tailscale, running herdr — the relay
plus Tailscale already covers this ground and reconnects better than plain SSH.
SSH's unique win is the "I have SSH to a server I don't want to install anything
on" user. If that audience matters, the cheapest honest shape is
*bootstrap-and-reuse*: lean on the user's existing SSH agent and `~/.ssh/config`
— never mint or manage keys, never ship a bespoke SSH stack — to place and start
a minimal muxr host component, then run the normal relay session over it, so the
free reconnection survives. Deciding this is T2 or T3 depending on how much
authority the SSH path carries, and it is the captain's call, not this
document's.

---

## 7. Where muxr is already equal or better

Listed so these are not "fixed" into something worse.

- **Version-mismatch handling.** An amber banner naming both versions plus a
  calm explanation that differing versions do not by themselves mean a broken
  connection. Neither competitor has a screen for this failure — Moshi is
  store-managed and single-version, Collie always serves the PWA it runs.
  *(Observed: `[muxr-08]`, `ConnectionSupport.tsx:43-48`.)*
- **Free session reconnection** after a network drop (§6.4).
- **The grant-enumerating consent screen** (§6.3).
- **Verifiable binary** — the download page prints the APK SHA256 and the verify
  command. Moshi is store-only; Collie verifies only its tarball.
- **Revoked-device recovery** — "This device was revoked — claim a fresh link",
  with the precise failure reason. *(Observed: `[muxr-00]`, `[muxr-01]`.)*
- **`muxr doctor`** is equal to or better than `collie doctor`.
- **`muxr report`** builds a redacted local draft and never auto-sends; Moshi's
  support flow auto-attaches a recovery log to an email.
- **Never installs skills or edits agent instruction files.** Moshi's skill page
  asks you to allow exactly that. A real trust-axis difference.

---

## 8. What this study could not check

Stated so nobody treats absence as evidence.

- **No device this pass.** The competitor observations are from the 2026-09-13
  audit. Nothing here was re-verified on hardware, and Moshi or Collie may have
  shipped changes since.
- **Two gaps the original audit names honestly and this study does not fill:**
  the composer insertion frame, and live streaming partials from a streaming
  engine. The partials question needs a re-paired session and injected speech;
  the room was silent during capture, so Whisper returned only ambient noise.
  Moshi's *default* Whisper path is batch (§2.8) — whether Parakeet or Cloud
  streams partials into the live composer is **unknown**, not "no".
- **muxr's own SSH option was not exercised.** A "Connect over SSH" entry is
  referenced in our docs; it was not run in the audit, so §6.4 reasons about
  Moshi's SSH model rather than ours.
- **Collie's paired-device write-gating was observed only in its unpaired
  state** ("Nothing is paired, so writes are ungated"). The gated behaviour was
  not exercised.
- **Moshi's iOS build was not tested** — all observations are Android.

---

## Appendix — evidence index

Captures live in the audit pane's attachment directory, referenced by the
filenames cited inline. Highlights:

- **Moshi:** first launch `moshi-01`, connect fork `moshi-02`, Easy-Pair sheet
  `moshi-03`/`04`, pair confirm `moshi-05`/`06`, live shell `moshi-08`, offline
  `moshi-11`, hook-down fix `moshi-13`/`14`, SSH timeout `moshi-18`, manual-SSH
  form `moshi-20`, key generation `moshi-24`, settings root
  `moshi-set-00-root`, speech `moshi-set-speech`, shortcuts
  `moshi-set-shortcuts`, discover `moshi-set-discover`, transcription arc
  `moshi-transcription-arc.mp4`.
- **Collie:** herd `collie-06`, settings `collie-set-settings-top`, pane detail
  `collie-08`, pane actions `collie-pane-actions`, agent palette
  `collie-sheet-agent`, offline `collie-10`, bridge-down `collie-12`, host
  install `collie-host-01`, `.env.example` `collie-host-02`, doctor
  `collie-host-04`.
- **muxr:** revoked state `muxr-00`/`01`, cold `muxr-02`, consent `muxr-05`,
  paired home `muxr-07`, version mismatch `muxr-08`, offline `muxr-10`,
  recovered `muxr-11`, host wizard `muxr-host-02`..`07`, pairing QR
  `muxr-host-10`.

muxr source paths cited in §4 and §6 are in this repository at the commit this
document lands on.
