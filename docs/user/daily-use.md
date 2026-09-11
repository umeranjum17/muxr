# Daily use

What the browser app does once your computer is paired, what the native app adds, and what to do when something drops.

## The Herd

The home screen lists every agent on every paired computer, grouped by repository (**Spaces**), with a live terminal thumbnail and a state: **Working**, **Needs you**, **Done**. The **Needs you** count is global: an agent waiting anywhere is one tap away. **Status** shows provider usage and machine vitals from the computer.

## Attention and approvals

An agent that asks a question or wants an approval becomes **Needs you**. Open it and answer in its real terminal: the composer sends to the same session the agent runs in, the key row sends modifier keys, and approvals happen in the terminal itself. With a **View-only** grant you can read everything and send nothing; the screen says so.

## Terminal

- The terminal is the agent's own pane, rendered live. Scroll back, copy, tap links; the status pill shows connecting, reconnecting, live, or the exact failure with **Tap to retry**.
- Modifier keys, Tab and Escape are in the key row. CJK and other IME input composes in the composer and is sent whole.
- **Screen-reader mode** and the terminal font size are in Settings → Appearance and apply to the live terminal.
- Attachments: add images from the composer; a failed upload is kept with **Retry** and **Discard**, never silently dropped. Downloads of large files are byte-identical to the file on your computer.

## Files and Changes

**Files** browses the repository behind a session and opens text, images and documents; binary and partial reads say so. **Changes** reviews the working tree, staged changes or the branch against `main`, with word-level diffs. Runbooks and history are under the same plugin.

## New agents, shells and worktrees

**New agent** starts an agent in a new Herdr pane in a repository or a worktree of your choice; a directory outside your home works too. **Panes → New shell** opens a plain shell. Everything you start appears in Herdr on the computer, exactly where the app put it.

## Preview and takeover

**Preview** opens a dev server running on your computer inside the app, through the encrypted channel, in a sandbox that keeps it away from the app's own storage. HMR sockets, WebSocket upgrades and cross-origin fetches from inside the previewed page are not carried; the page says which. **Takeover** shows a graphical pane and forwards touch, drag, wheel, text and IME input; one device controls at a time, and taking control from another device is an explicit choice.

## Voice

**Talk** on a session starts a realtime, streaming voice conversation with that agent's context: speak, hear the answer, interrupt by talking. The browser needs the tab in the foreground; the native app keeps the microphone in a foreground service so it survives the screen turning off. Voice is available only when the computer has a provider set up: on it, run `muxr voice` (or open the Herdr pane **muxr host voice**). The app never sees which provider answers or any key.

**Dictation** is different: it edits the draft in the composer and sends nothing until you do. On Android and iOS it transcribes on the device; in a browser it uses the browser's own speech recognition where one exists (Chrome, Edge, Safari) and says so where none does.

## Notifications

Turn notifications on from Settings when you first want them. They arrive when an agent needs you and open the request directly; the app never approves anything on your behalf.

## Recovery and reconnecting

- Losing the network: the app reconnects on its own and tells you why it is waiting.
- **Access expired** or **Access removed**: the browser grant reached its lifetime or was revoked from the computer. The status pill says **Pair again**; run `muxr pair --browser` on the computer and open the new link in this browser.
- Reinstalling or reopening the installed app keeps its pairing; on iOS the installed app and the Safari tab are separate and each needs its own link.
- Changing the computer's route (for example from same Wi-Fi to Tailscale) needs a fresh pairing; the app tells you.

## Native app differences

The native app adds what a browser cannot: a background microphone service for voice, discovery of a computer on the same Wi-Fi without typing anything, and phone integrations (shortcuts, launcher actions, watch). Everything else is the same app. Install it from the links in the table below; it pairs with `muxr pair --native`.

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

Next: [Configuration](configuration.md) for a repeatable setup, or [Trust](trust.md) for what each part can see.
