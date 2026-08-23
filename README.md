<p align="center">
  <img src="docs/play/store-assets/store-icon.png" width="96" alt="muxr" />
</p>

<h1 align="center">muxr</h1>

<p align="center"><strong>Every coding agent, on your phone.</strong></p>

<p align="center">
  muxr shows you which agents need attention and lets you answer from your phone. The work stays on your computer; you do not have to.
</p>

<p align="center">
  <a href="https://trymuxr.com">Website</a> ·
  <a href="https://trymuxr.com/docs/quickstart">Quickstart</a> ·
  <a href="https://trymuxr.com/#demo">Demo</a> ·
  <a href="https://github.com/umeranjum17/muxr/releases/latest">Android</a> ·
  <a href="https://trymuxr.com/docs/plugins">Extensions</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@trymuxr/cli"><img alt="npm" src="https://img.shields.io/npm/v/@trymuxr/cli?style=flat-square&label=npm" /></a>
  <a href="https://github.com/umeranjum17/muxr/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/umeranjum17/muxr/ci.yml?style=flat-square&branch=main" /></a>
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-666?style=flat-square" /></a>
</p>

[![See muxr in action](docs/demo/muxr-loop.webp)](https://trymuxr.com/#demo)

<p align="center">
  <img src="docs/screenshots/v0112/dark/herd.png" height="380" alt="muxr home in dark: the herd, with live agent terminals and every session grouped by repo" />
  <img src="docs/screenshots/v0112/dark/voice.png" height="380" alt="muxr realtime voice: a live speech-to-speech session, the visual reacting to the conversation" />
  <img src="docs/screenshots/v0112/light/changes.png" height="380" alt="A commit diff in muxr: per-file tab rail, dual line-number gutter, add and remove tints" />
  <img src="docs/screenshots/v0112/dark/connection.png" height="380" alt="muxr connection: self-hosted transport over Tailscale, end-to-end encrypted, you run the relay" />
</p>

![muxr as an RPG party command center: Herd, terminal, changes, Inbox, voice, and self-hosted relay](docs/art/rpg-cover.png)

## Why muxr

- **Know when you are needed.** See every agent in one place and spot the ones waiting for input.
- **Unblock the work from anywhere.** Answer prompts, use the terminal, review changes, move files, or talk to an agent from your phone.
- **Keep one continuous session.** Step away and come back to the same agents, terminals, and context.
- **Keep control of your work.** Your agents run on your computers. Connections are end-to-end encrypted, and the host and relay are open source.

## Install

You need [Node.js 22 or newer](https://nodejs.org/) on Linux, macOS, or WSL. muxr installs [Herdr](https://herdr.dev) automatically during setup if it is missing.

```bash
npm install -g --ignore-scripts @trymuxr/cli
muxr
```

Then:

1. Install muxr on your phone from TestFlight, Google Play internal testing, or the signed Android APK below.
2. Run `muxr`. It checks the computer, installs Herdr if needed, and asks how your phone should connect. Start with LAN if both devices are on the same wifi.
3. Choose **Apply setup**, open the phone app, and scan the one-use QR.

- **Android:** internal testing on Google Play · [signed APK and SHA256SUMS](https://github.com/umeranjum17/muxr/releases/latest)
- **iOS:** internal testing on TestFlight
- **Web:** choose the eight-hour read-only browser client during setup

[Request mobile access](https://github.com/umeranjum17/muxr/issues), or read the [step-by-step quickstart](https://trymuxr.com/docs/quickstart).

## Use the agents you already have

muxr connects to the sessions [Herdr](https://github.com/herdrdev/herdr) already runs. Your CLIs, subscriptions, configuration, skills, and MCP servers stay as they are.

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

Start with the [extension guide](https://trymuxr.com/docs/plugins) and the [bundled examples](plugins/).

## Self-hosting

Run muxr on one computer or connect several through a relay you operate. Use your local network, Tailscale, Cloudflare, or your own WSS endpoint.

- [Quickstart](https://trymuxr.com/docs/quickstart)
- [Self-hosting](docs/SELF-HOSTING.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Security](SECURITY.md)
- [Voice](docs/VOICE-SETUP.md)

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
