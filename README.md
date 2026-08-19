<p align="center">
  <img src="docs/play/store-assets/store-icon.png" width="96" alt="muxr" />
</p>

<h1 align="center">muxr</h1>

<p align="center"><strong>Every coding agent, on your phone.</strong></p>

<p align="center">
  Start on your desktop, step away with your phone, and come back without a handoff. Watch terminals, answer prompts, send instructions, move files, and talk to the same agents while your machine stays the source of truth.
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

[![muxr — every coding agent, on your phone](docs/screenshots/v015/rpg-herd.png)](https://trymuxr.com/#demo)

<p align="center">
  <img src="docs/screenshots/v015/home.png" height="420" alt="muxr home: the herd with live agent terminals" />
  <img src="docs/screenshots/v015/claude.png" height="420" alt="Claude Code terminal in muxr" />
  <img src="docs/screenshots/v015/codex.png" height="420" alt="Codex terminal in muxr" />
  <img src="docs/screenshots/v015/kimi.png" height="420" alt="Kimi Code terminal in muxr" />
</p>
<p align="center"><em>Real Herdr panes, real agents — captured from the shipping app.</em></p>

## What it does

- **One herd:** see every agent and terminal, including who is working, blocked, or done.
- **Seamless continuity:** switch between desktop and phone without moving sessions or losing context — the same machines, panes, and agents stay live.
- **Real terminal control:** read output, type, prompt, interrupt, and manage sessions remotely.
- **Phone-native tools:** Files, Changes, attachments, Runbook, Usage, Voice, and notifications.
- **End-to-end encrypted:** relays route encrypted envelopes; your code and terminal output stay between your devices.
- **Open extension platform:** bundled and third-party extensions use the same bounded public contract. No plugin HTML or arbitrary WebViews.

## Install

You need [Node.js 22 or newer](https://nodejs.org/) and [Herdr](https://herdr.dev) on Linux, macOS, or WSL. If Herdr is missing, setup offers to install it from herdr.dev — nothing is installed or changed until you approve the plan.

```bash
npm install -g @trymuxr/cli
muxr
```

The setup wizard inspects first and changes nothing until you review the plan and choose **Apply setup**. Pick local network, Tailscale, Cloudflare, your own WSS endpoint, or a shared self-hosted relay. Then scan the one-use QR with the app.

- **Android:** [signed APK](https://github.com/umeranjum17/muxr/releases/download/v0.1.7/muxr-0.1.7.apk) · [SHA256SUMS](https://github.com/umeranjum17/muxr/releases/download/v0.1.7/SHA256SUMS) · Google Play coming soon
- **Web:** choose the eight-hour read-only browser client during setup
- **iOS:** in development, not yet available

Read the [step-by-step quickstart](https://trymuxr.com/docs/quickstart).

## Agents

muxr reads the agent catalog from [Herdr](https://github.com/herdrdev/herdr) and works with what is installed on your machine:

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

Pi, Claude Code, Codex, Gemini CLI, Cursor, OpenCode, GitHub Copilot CLI, Kimi Code, Grok, Hermes, Amp, Droid, Devin, Cline, Kiro, Kilo Code, Qwen, OMP, Qoder, Maki, MastraCode, and custom Herdr agent kinds.

muxr does not replace or wrap them. Herdr owns their real terminal sessions; muxr gives you a secure remote surface.

## Extensions

Extensions can add native controls, screens, files, diffs, trees, metrics, charts, shortcuts, events, and backend streams through a versioned public API. The app renders compiled, theme-aware components; extensions never download executable UI.

Start with the [extension guide](https://trymuxr.com/docs/plugins) and the [bundled examples](plugins/).

## Self-hosting

The host and relay are open source. Run everything on one computer, expose it with Tailscale or Cloudflare, connect to your own WSS endpoint, or enroll machines into a relay you operate.

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
