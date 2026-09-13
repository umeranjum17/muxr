# What muxr is

muxr lets you see and steer the coding agents running on your computer from a browser or a phone: who is working, who needs you, who is done, and the exact live terminal of each one.

## The three parts

- **Your computer** runs your coding agents inside [Herdr](https://herdr.dev), plus the muxr **host**, which reads those sessions and serves the app.
- The **relay** carries encrypted traffic between your devices and the host. It cannot read what it carries. It normally runs on the same computer.
- The **browser app** is the daily client: served from your computer's own HTTPS origin, optionally installed to your home screen. The **native app** (Android, iOS) is an optional upgrade for background microphone and phone integrations.

Nothing about your agents, repositories, model subscriptions or credentials leaves your computer. There is no account and nothing to host elsewhere.

## What muxr does

- Shows every agent on every paired computer in one Herd, grouped by repository, with live terminal thumbnails and lifecycle: **Working**, **Needs you**, **Done**.
- Opens an agent's real terminal, with modifier keys, attachments, dictation and a prompt box that talks to the same session.
- Reviews files and changes, previews a dev server, takes over a graphical pane, and talks to an agent by realtime voice when your computer has a voice provider set up.
- Tells you when an agent needs you, if you turn notifications on.

## What muxr does not do

- It does not run agents, hold model keys or store your code anywhere but your computer.
- It does not host your data on trymuxr.com. The public site serves a scripted demo only; the app you use every day is served by your own computer.
- It does not replace Herdr. Herdr owns panes, tabs and workspaces; muxr is the window onto them.

## The demo and a real host

[trymuxr.com/demo](https://trymuxr.com/demo) runs the production app against three scripted agents so you can try the real screens before installing anything. Preview, takeover and voice in the demo say they need a connected computer, because they do. Pair your own computer to see your own agents.

## Words used on every screen

| Word | Meaning |
|---|---|
| computer | the machine running Herdr and muxr |
| host | the muxr process on that computer |
| relay | routes encrypted traffic; cannot read it |
| browser app | the client served from your computer, installable as a web app |
| native app | the optional Android or iOS client |
| Herd | the home screen: every agent, grouped by repository |
| Needs you | an agent waiting for an answer or an approval |
| pairing link | a one-use link or QR from your computer, valid for a few minutes |
| browser access | a Control or View-only grant for hours, or Personal Control for days |

<!-- release-facts:start -->
| Fact | Value |
|---|---|
| Current release | `@trymuxr/cli@0.1.28` (tag `v0.1.28`) |
| Minimum Herdr | 0.8.0 |
| Minimum Node (npm path) | 22 |
| Default relay port | 8792 |
| Pairing link | one use, expires in 2 minutes |
| Browser access (Control or View-only) | 8 hours |
| Personal Control (installed browser you own) | 30 days |
| Machine enrollment (shared relay) | 5 minutes |
| Native apps | optional: [Android APK](https://trymuxr.com/downloads/stable/android) ([checksums](https://trymuxr.com/downloads/stable/checksums)), [Google Play testing](https://play.google.com/apps/testing/com.trymuxr.app), [iOS TestFlight](https://testflight.apple.com/join/aJSbs8pN) — availability depends on store review; [all channels](https://trymuxr.com/downloads) |
<!-- release-facts:end -->

Next: [Install and connect your computer](install.md).
