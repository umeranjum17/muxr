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
  <a href="https://github.com/umeranjum17/muxr/issues/new?template=mobile-access.yml">Request TestFlight</a> ·
  <a href="https://github.com/umeranjum17/muxr/releases/download/v0.1.7/muxr-0.1.7.apk">Latest direct APK: 0.1.7</a> ·
  <a href="https://github.com/umeranjum17/muxr/releases">All releases</a>
</p>

<p align="center">
  <a href="https://trymuxr.com/#demo"><img src="docs/demo/muxr-loop.webp" alt="The muxr herd, an agent's exact live terminal, and a prompt continuing on the computer" width="960" /></a>
</p>

## Why muxr exists

Coding agents made programming asynchronous: they work for minutes or hours, then stop and wait for you. Your phone is where you already are during those waits — but a terminal squeezed into a phone browser is unusable, and a notification app cannot actually answer.

muxr is the control surface built natively for the phone: the full agent lifecycle on one screen, the exact terminal when you tap in, and a prompt box that talks to the same session. Execution, code, credentials, and model subscriptions stay on your computers.

## See it in action

<table>
<tr>
<td width="45%" valign="middle">

### The whole herd, then the exact terminal

Every agent on every machine, grouped by repo, with live status: working, needs you, done. Tap the one that needs you and you are in its real terminal — same scrollback, same session — not a summary of it. Type or dictate the next prompt and the agent continues on your computer.

[Watch the full demo →](https://trymuxr.com/#demo)

</td>
<td width="55%">
  <a href="https://trymuxr.com/#demo"><picture><source srcset="docs/assets/readme/herd.webp" type="image/webp"><img src="docs/assets/readme/herd.jpg" alt="The muxr herd showing agent lifecycles, then the same agent's live terminal prompted from the phone" width="100%" /></picture></a>
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

### Talk to the work

Use native realtime speech-to-speech when typing is the slow part. Ask what changed, give a follow-up, and keep the same agent context.

[Voice setup →](docs/VOICE-SETUP.md)

</td>
<td width="55%">
  <picture><source srcset="docs/assets/readme/voice.webp" type="image/webp"><img src="docs/assets/readme/voice.jpg" alt="A realtime voice session in muxr" width="100%" /></picture>
</td>
</tr>
<tr>
<td width="45%" valign="middle">

### Your relay or ours. Never our eyes.

Connect over Wi-Fi, Tailscale, a relay you run, or muxr Cloud's optional managed relay. Either way, terminal output, keystrokes, and approvals are end-to-end encrypted before they leave your devices. The relay routes ciphertext it cannot read.

[Self-hosting →](docs/SELF-HOSTING.md) · [Privacy →](https://trymuxr.com/docs/privacy) · [Architecture →](docs/ARCHITECTURE.md) · [Security →](SECURITY.md)

</td>
<td width="55%">
  <picture><source srcset="docs/assets/readme/self-host.webp" type="image/webp"><img src="docs/assets/readme/self-host.jpg" alt="muxr connected through an end-to-end encrypted self-hosted relay" width="100%" /></picture>
</td>
</tr>
</table>

**Also on your phone:**

- **Live terminals and notifications** — see every running session and know the moment one needs you.
- **Files, attachments, ports, usage, and runbooks** — inspect the machine without squeezing a desktop UI onto a phone.
- **[Extensions](https://trymuxr.com/docs/plugins)** — add phone-native controls and screens without forking the app.

The [release history](https://github.com/umeranjum17/muxr/releases) is the real feature list.

## The whole party, in one place

Parallel agents work like a party: each has a job, a state, and moments when it needs you. muxr keeps the real terminals, diffs, inbox, voice, and relay controls together without hiding what is happening.

![muxr as an RPG party command center: Herd, terminal, changes, Inbox, voice, and self-hosted relay](docs/art/rpg-cover.png)

## Cloud without a cloud computer

Your phone and computer need a way to find each other across networks. They do not need us to run your agents.

**muxr Cloud** is the optional managed relay. Your computer connects outbound; your phone connects to the same relay. It moves end-to-end-encrypted frames and wakes the phone when an agent needs attention. It cannot read terminal text, prompts, responses, keystrokes, files, or pairing secrets. Agents, repositories, credentials, and encryption keys stay on your computer.

muxr Cloud is rolling out to testers now. Self-hosting is available to everyone today over Wi-Fi, Tailscale, or a VPS. The app and features are the same either way.

[Privacy and trust →](https://trymuxr.com/docs/privacy) · [Self-hosting →](docs/SELF-HOSTING.md)

## Install

You need [Node.js 22 or newer](https://nodejs.org/) on Linux, macOS, or WSL. muxr installs [Herdr](https://herdr.dev) during setup if it is missing.

```bash
npm install -g --ignore-scripts @trymuxr/cli
muxr
```

Then install the mobile companion:

- **Android:** [join Google Play testing](https://play.google.com/apps/testing/com.trymuxr.app) · [download the latest direct APK (0.1.7)](https://github.com/umeranjum17/muxr/releases/download/v0.1.7/muxr-0.1.7.apk) · [SHA256SUMS](https://github.com/umeranjum17/muxr/releases/download/v0.1.7/SHA256SUMS)
- **iOS:** [request TestFlight access](https://github.com/umeranjum17/muxr/issues/new?template=mobile-access.yml)
- **Web:** pair an eight-hour read-only browser during self-hosted setup
- **All builds:** [GitHub Releases](https://github.com/umeranjum17/muxr/releases)

Verify a downloaded APK with `sha256sum --ignore-missing -c SHA256SUMS`, then run `muxr`, choose **Apply setup**, and scan the one-use QR from the phone. Start with LAN when both devices are on the same Wi-Fi.

[Read the step-by-step quickstart →](https://trymuxr.com/docs/quickstart)

## Use the agents you already have

muxr connects to sessions [Herdr](https://github.com/herdrdev/herdr) already runs. Your CLIs, subscriptions, configuration, skills, and MCP servers stay as they are.

<p>
  <img src="docs/agents/icons/pi.svg" width="28" alt="Pi" title="Pi" />
  <img src="docs/agents/icons/claude.svg" width="28" alt="Claude Code" title="Claude Code" />
  <img src="docs/agents/icons/codex.svg" width="28" alt="Codex" title="Codex" />
  <img src="docs/agents/icons/gemini.svg" width="28" alt="Gemini CLI" title="Gemini CLI" />
  <img src="docs/agents/icons/cursor.svg" width="28" alt="Cursor" title="Cursor" />
  <img src="docs/agents/icons/opencode.svg" width="28" alt="OpenCode" title="OpenCode" />
  <img src="docs/agents/icons/copilot.svg" width="28" alt="GitHub Copilot CLI" title="GitHub Copilot CLI" />
  <img src="docs/agents/icons/kimi.svg" width="28" alt="Kimi Code" title="Kimi Code" />
  <img src="docs/agents/icons/grok.svg" width="28" alt="Grok" title="Grok" />
  <img src="docs/agents/icons/hermes.svg" width="28" alt="Hermes Agent" title="Hermes Agent" />
  <img src="docs/agents/icons/amp.svg" width="28" alt="Amp" title="Amp" />
  <img src="docs/agents/icons/droid.svg" width="28" alt="Factory Droid" title="Factory Droid" />
  <img src="docs/agents/icons/devin.svg" width="28" alt="Devin" title="Devin" />
  <img src="docs/agents/icons/cline.svg" width="28" alt="Cline" title="Cline" />
  <img src="docs/agents/icons/kiro.svg" width="28" alt="Kiro" title="Kiro" />
  <img src="docs/agents/icons/kilocode.svg" width="28" alt="Kilo Code" title="Kilo Code" />
  <img src="docs/agents/icons/qoder.svg" width="28" alt="Qoder CLI" title="Qoder CLI" />
  <img src="docs/agents/icons/omp.svg" width="28" alt="OMP (Oh My Pi)" title="OMP (Oh My Pi)" />
  <img src="docs/agents/icons/antigravity.svg" width="28" alt="Antigravity" title="Antigravity" />
  <img src="docs/agents/icons/mastracode.svg" width="28" alt="MastraCode" title="MastraCode" />
  <img src="docs/agents/icons/maki.svg" width="28" alt="Maki" title="Maki" />
</p>

## Extensions

Add phone-native controls, screens, files, diffs, metrics, shortcuts, and realtime streams through the public extension API.

[Extension guide →](https://trymuxr.com/docs/plugins) · [Bundled examples →](plugins/)

## Development

```bash
git clone https://github.com/umeranjum17/muxr
cd muxr
yarn install --frozen-lockfile
yarn typecheck
node scripts/runSuite.mjs
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and pull requests.

## License

muxr is licensed under [Apache License 2.0](LICENSE). Third-party notices are recorded in [NOTICE](NOTICE) and the [license inventory](docs/license-inventory.md). The muxr name and marks are covered by [TRADEMARK.md](TRADEMARK.md).
