# Vision

## Who it is for

People who run coding agents on their own computers and do not want to sit at the desk waiting for them. You do not need to be technical to use muxr.

## The problem

An agent can work for a while, then need one answer to keep going. If you are away from the desk, it waits, and so does the work.

## Where we are going

When an agent needs you, you answer from your phone, in the same live terminal, without starting over. Getting there is the easy part:

- **Three ways in, all first class.** Just your phone, your phone plus a cloud computer, or your phone plus your own computer. Adding a computer and switching between them is reliable and seamless.
- **Up and running in under five minutes** on each of those, from install to the first useful result. One clear path each: no jargon, no terminal, no dead ends, and every failure recovers in place.
- **It stays connected.** A phone or tablet stays connected all day, with no trip back to the desk.
- **The whole computer when you need it.** One desktop action inside the agent's conversation opens your real desktop in that same session, then returns you cleanly to the conversation. One browser that you and the agent share, not two.

## Principles

- **Yours, on your computers.** Self-hosted and open source. Your agents, code, sign-ins and model subscriptions stay on your computers; you bring your own AI and cloud accounts. Terminal traffic, prompts and files are end-to-end encrypted.
- **Plain words.** Zero jargon in the app and on first run, written for someone who is not technical.
- **The real terminal.** [Herdr](https://herdr.dev) owns the terminal, its scrollback and every name; muxr shows what Herdr says and never keeps a second copy.
- **Work with what people install.** muxr runs against the published versions of the agents and tools you already use, as they are.
- **One app everywhere.** One React Native app for Android and iOS, and an installed web app that is as close to native as it can be. The desktop app runs on Linux now; Mac and Windows come later.

## Quality bar

- The main path of every feature works **and** looks right on its first release. A design or flow defect on the main path counts like a crash.
- Rough edges are fine only in rare cases, never on the main path.
- Snappy: opening a pane and scrolling its history feel instant.
- Proven on the real app, on a real device or emulator, before it ships. A browser preview is not proof.

## What it is not

- Not a hosted service. Your agents run on your machines, and muxr runs no paid hosted relay: you bring your own network, such as Tailscale, to reach them away from home.
- Not a separate remote-desktop product or a second control surface. The desktop opens inside the agent's conversation.
- Not a plugin platform. Herdr is the plugin system; muxr consumes Herdr actions.
- Not a speech pipeline stitched together from parts. Realtime voice is native speech-to-speech, and dictation runs on the device.

## Next milestones

Every release, with its notes, is on the [releases page](https://github.com/umeranjum17/muxr/releases); [RELEASING.md](docs/RELEASING.md) explains the stable and nightly channels.

1. **Stable catches up.** The recent pre-releases (0.2.10 to 0.2.12: the chat view, native pane scrolling, moving a conversation to another account, roomier terminal keys) move to the stable APK and npm `latest` once the real-app release journey passes on that exact build.
2. **muxr 0.2.13.** The chat view in the light theme, the Linux desktop app first on the first screen, and the gaps in a pane's scroll history filled from the computer.
3. **Five minutes, every way in.** Phone only, phone plus a cloud computer, and phone plus your own computer, each shown with a timed recording on a clean device from install to the first useful result.
