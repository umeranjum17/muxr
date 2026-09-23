<h1 align="center">
  <a href="https://trymuxr.com"><img src="docs/play/store-assets/store-icon.png" width="72" alt="muxr" valign="middle" /></a> muxr
</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@trymuxr/cli"><img alt="npm" src="https://img.shields.io/npm/v/@trymuxr/cli?style=flat&label=npm" /></a>
  <a href="https://github.com/umeranjum17/muxr/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/umeranjum17/muxr/ci.yml?style=flat&branch=main" /></a>
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-666?style=flat" /></a>
  <img alt="iOS and Android" src="https://img.shields.io/badge/iOS%20%7C%20Android-111?style=flat" />
</p>

<p align="center">
  <strong>Every agent. The real terminal. In your pocket.</strong><br/>
  muxr is a mobile-first client for the coding agents running on your computers. See the whole herd at a glance — who's working, who needs you, who's done. Open any agent's exact live terminal, prompt it like you're at the desk, and watch it keep executing on your machine. Not a dashboard about your agents — the same session, built for a thumb.
</p>

<h3 align="center"><a href="https://trymuxr.com/docs/quickstart"><ins>Get muxr</ins></a></h3>

<p align="center">
  <a href="https://play.google.com/apps/testing/com.trymuxr.app">Google Play testing</a> ·
  <a href="https://testflight.apple.com/join/aJSbs8pN">iOS TestFlight</a> ·
  <a href="https://trymuxr.com/downloads/stable/android">Download the Android APK</a> ·
  <a href="https://trymuxr.com/downloads">Stable and nightly</a>
</p>

<p align="center">
  <img src="docs/demo/muxr-loop.webp" alt="The muxr herd, an agent's exact live terminal, and a prompt continuing on the computer" width="960" />
</p>

## Why muxr exists

Coding agents made programming asynchronous: they work for minutes or hours, then stop and wait for you. Your phone is where you already are during those waits — but a terminal squeezed into a phone browser is unusable, and a notification app cannot actually answer.

muxr is the control surface built natively for the phone: the full agent lifecycle on one screen, the exact terminal when you tap in, and a prompt box that talks to the same session. Execution, code, credentials, and model subscriptions stay on your computers.

## See it in action

<table>
<tr>
<td width="45%" valign="middle">

### A real terminal, built for thumbs

Open the same live terminal the agent owns on your computer — native Ghostty rendering, scrollback, sticky modifier keys, a key row you can reorder and extend with keys of your own, and a floating control you can move, tap for actions, or sweep into an arrow cluster. By default, swipe sideways with one finger to page through working, starting, blocked, or recently finished agents in the Live strip's order; the next screen follows your finger, and the first and last agents do not wrap around. In Settings → Gestures, choose a two-finger swipe or turn swiping off, and choose whether swipes stop at those agents or every agent in the strip. Vertical drags still scroll the terminal and a resting finger can select text. Pinching changes the shared terminal text size unless disabled in Gestures; Appearance also sets the size. The compact header keeps the pane menu within reach; the bottom composer keeps attachments and dictation beside the prompt, with realtime talk on an empty prompt and lifecycle-colored Send when there is something to send. When a blocked Claude Code or Codex agent shows numbered answers, tap an answer at the live edge of the terminal instead of finding its key; long-press to read a long answer in full before choosing. The answers disappear when you scroll back, and the floating control gives them room while they are visible. Tap a printed link to choose Open, Copy, or Insert into the prompt (when available); Recent links are in the pane menu.

</td>
<td width="55%">
  <a href="https://trymuxr.com/#demo"><picture><source srcset="docs/assets/readme/terminal.webp" type="image/webp"><img src="docs/assets/readme/terminal.jpg" alt="muxr's redesigned terminal with compact header, floating quick actions, key row, and prompt composer" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="45%" valign="middle">

### Every agent, every machine

The Herd groups agents by repository and nests spawned workspaces when their lineage is declared. See real terminal thumbnails and agent lifecycle: working, needs you, done. Tap any agent and you are back in the same session.

</td>
<td width="55%">
  <picture><source srcset="docs/assets/readme/herd.webp" type="image/webp"><img src="docs/assets/readme/herd.jpg" alt="The muxr Herd with live terminal thumbnails, repository spaces, and agent lifecycle states" width="100%" /></picture>
</td>
</tr>
<tr>
<td width="45%" valign="middle">

### Know who needs you

Inbox collects attention across every repository. Open the waiting agent directly instead of hunting through terminals or notification history.

</td>
<td width="55%">
  <picture><source srcset="docs/assets/readme/inbox.webp" type="image/webp"><img src="docs/assets/readme/inbox.jpg" alt="muxr Inbox sorting agents that need attention from agents that finished" width="100%" /></picture>
</td>
</tr>
<tr>
<td width="45%" valign="middle">

### Review before it ships

Open the real diff, inspect every changed line, then accept or reject it without waiting to get back to your desk.

</td>
<td width="55%">
  <picture><source srcset="docs/assets/readme/changes.webp" type="image/webp"><img src="docs/assets/readme/changes.jpg" alt="Reviewing an agent's code changes in muxr" width="100%" /></picture>
</td>
</tr>
<tr>
<td width="45%" valign="middle">

### Talk to the herd

Use native realtime speech-to-speech when typing is the slow part. Ask what changed, give a follow-up, and keep the same agent context.

[Voice setup →](docs/VOICE-SETUP.md)

</td>
<td width="55%">
  <picture><source srcset="docs/assets/readme/voice.webp" type="image/webp"><img src="docs/assets/readme/voice.jpg" alt="A native realtime voice session in muxr" width="100%" /></picture>
</td>
</tr>
</table>

**Also on your phone:**

- **New agents and worktrees** — open the home composer to choose the machine, repository, worktree, and one of 20+ agent CLIs. The resting dock hides Send until there's a draft or a submission in progress. On a short phone, scroll the open composer to reach its options and Start when the keyboard is visible. On a later launch, Home can show the last confirmed agents and spaces while reconnecting; they appear dimmed until the host responds, and closing a remembered space is unavailable.
- **Files, attachments, and changes** — inspect repository files, diffs, and agent outputs from your phone; download an agent's Shared Artifacts with progress and resume after a lost connection. On web, a download finished in the background offers **Save** when you return.
- **Settings** — under Appearance, choose a theme and terminal text size; the browser terminal also offers System or IBM Plex Mono. Gestures lists terminal actions and the swipe and zoom choices described above. Under Notifications, choose alerts for agents needing you or finishing; enable browser notifications in the web app or manage permission and sound in your phone's system settings.
- **Usage** — see each plan window's percent left, reset time, and pace when known; Home shows every connected plan's limits at a glance, each plan's mark over what is left of its windows, alongside machine health.
- **Desktop control (Linux)** — open **Computer** from a controllable agent session to see and drive that machine's desktop. A restored desktop waits for **Start desktop** before capture; after backgrounding or reconnecting, its picture can return but control stays off until you tap **Tap to control** (that tap is not sent to the desktop). A minimal header shows the conversation title, gesture help and more actions; floating clipboard and keyboard buttons rise with the phone keyboard and shortcut keys while the picture and touch pointer stay in view. The app requests up to 60 fps for moving desktops, subject to the host's capture and encoding rate. On web, **Copy to Phone** needs browser clipboard access; allow it if blocked, then retry. The signaling relay does not carry video: Android and web can connect directly over a reachable network or tailnet, and Android native can carry the desktop over its [Direct SSH route](docs/SELF-HOSTING.md#direct-ssh-from-android) when only SSH is reachable. iOS does not have a desktop client. The CLI installs the desktop engine as a dependency, prebuilt for Linux x64 (glibc 2.36 or newer); portal-based control requires a one-time [kernel input grant](packages/desktop-host/README.md#kernel-input-access). A Wayland session (including a detected compositor socket) uses the consent-bearing portal. Otherwise muxr uses `DISPLAY`, then the lowest-numbered X socket owned by the host account; without either it uses the portal. Set `MUXR_DESKTOP_SOURCE=x11` (optionally `MUXR_DESKTOP_X11_DISPLAY=:99`) or `MUXR_DESKTOP_SOURCE=portal` to override detection. [Host setup](packages/desktop-host/README.md) · [Client](packages/desktop-client/README.md)
- **[Extensions](https://trymuxr.com/docs/plugins)** — add phone-native controls and screens without forking the app.

The [release history](https://github.com/umeranjum17/muxr/releases) is the real feature list.

## The whole party, in one place

Parallel agents work like a party: each has a job, a state, and moments when it needs you. muxr keeps the real terminals, diffs, inbox, and voice together without hiding what is happening.

![muxr as an RPG party command center with the Herd, terminal, changes, Inbox, and voice](docs/art/rpg-cover.png)

## Your machines, your relay

Your phone and computer stay connected over Wi-Fi, Tailscale, or a VPS you run. Nobody else runs your agents.

Terminal text, prompts, responses, keystrokes, files, pairing secrets, and credentials remain end-to-end encrypted. Agents, repositories, model subscriptions, and encryption keys stay on your computer.

[Privacy and trust →](https://trymuxr.com/docs/privacy) · [Self-hosting →](docs/SELF-HOSTING.md)

## Install

You need [Node.js 22 or newer](https://nodejs.org/) on Linux, macOS, or WSL. muxr installs [Herdr](https://herdr.dev) during setup if it is missing.

```bash
npm install -g --ignore-scripts @trymuxr/cli@latest
muxr
```

Want the newest build? Install it with `npm install -g --ignore-scripts @trymuxr/cli@nightly` and take its APK from the [nightly channel](https://trymuxr.com/downloads/nightly). The **Android app** installs alongside a stable one rather than replacing it, so you can keep both on the phone. On your computer both channels are the same CLI, so switching npm tags replaces the host you already run rather than adding a second one. Beta and dev are retired: moving across is that one install, and an older binary will not upgrade itself to a `-nightly` version.

Then install the mobile companion:

- **Android (stable):** [download the stable APK](https://trymuxr.com/downloads/stable/android) · [stable checksum](https://trymuxr.com/downloads/stable/checksums)
- **Google Play testing:** [join the testing track](https://play.google.com/apps/testing/com.trymuxr.app) — availability depends on Google review and testing access
- **iOS TestFlight:** [open the public link](https://testflight.apple.com/join/aJSbs8pN) — build availability depends on Apple review and tester capacity. Store tracks review and roll out on their own schedule, so they do not move with the nightly APK
- **Web:** pair an eight-hour control or view-only browser during self-hosted setup. On compact screens, Home opens running agents and a control grant adds the bottom composer to start one, instead of bottom tabs. Search, Panes, and Settings live in the header; Usage opens from Home or Settings.
- **All builds:** [every download channel](https://trymuxr.com/downloads)

Save the channel's checksum next to the downloaded APK as `SHA256SUMS`, verify it with `sha256sum --ignore-missing -c SHA256SUMS`, then run `muxr`. Each channel publishes its own checksum, so verify against the channel you downloaded from. Setup shows six routes with their requirements, recommends a ready route, and changes nothing until **Apply setup**. Scan the one-use QR from the phone when it is ready.

[Read the step-by-step quickstart →](https://trymuxr.com/docs/quickstart)

## Use the agents you already have

muxr connects to sessions [Herdr](https://github.com/herdrdev/herdr) already runs. Your CLIs, subscriptions, configuration, skills, and MCP servers stay as they are. muxr never edits agent instruction files; load the compact `muxr --skill`, then request one focused topic with `muxr skill <topic>` only when needed.

<p align="center">
  <img src="docs/agents/icons/agent-grid-light.svg#gh-light-mode-only" width="760" alt="Pi, OMP, Claude Code, Codex, Gemini CLI, Cursor, OpenCode, GitHub Copilot CLI, Kimi Code, Grok, Hermes Agent, Amp, Factory Droid, Devin, Cline, Kiro, Kilo Code, Qoder CLI, Antigravity, MastraCode, Maki, and Shell" />
  <img src="docs/agents/icons/agent-grid-dark.svg#gh-dark-mode-only" width="760" alt="Pi, OMP, Claude Code, Codex, Gemini CLI, Cursor, OpenCode, GitHub Copilot CLI, Kimi Code, Grok, Hermes Agent, Amp, Factory Droid, Devin, Cline, Kiro, Kilo Code, Qoder CLI, Antigravity, MastraCode, Maki, and Shell" />
</p>

## Extensions

Add phone-native controls, screens, files, diffs, metrics, shortcuts, and realtime streams through the public extension API.

[Extension guide →](https://trymuxr.com/docs/plugins)

## Development

```bash
git clone https://github.com/umeranjum17/muxr
cd muxr
yarn install --frozen-lockfile
yarn typecheck
yarn run check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and pull requests.

## License

muxr is licensed under [Apache License 2.0](LICENSE). Third-party notices are recorded in [NOTICE](NOTICE) and the [license inventory](docs/license-inventory.md). The muxr name and marks are covered by [TRADEMARK.md](TRADEMARK.md).

## Development and nightly builds

Merging into `main` advances development, not production. Use the [release channel workflow](docs/RELEASING.md) for signed nightly APKs, verified npm artifacts and explicit stable promotion. Emulator acceptance stays local.
