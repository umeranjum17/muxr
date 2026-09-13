# Trust: what each part can see and do

## End-to-end encryption

Terminal output, keystrokes, prompts, files, attachments, plugin streams, preview and takeover traffic are sealed on your computer and opened only on a paired device. Every session, terminal, attachment, plugin-stream, preview and takeover payload is encrypted; there is no plaintext mode.

## What the relay sees

The relay routes ciphertext and connection metadata (which device talks to which computer, when, how much). It never holds keys, prompts, terminal content or provider credentials, and it cannot read what it carries. When you run it yourself on the same computer, that is the whole story; a shared relay on a server you run sees the same nothing.

## Browser access: roles and lifetimes

A browser is paired with an explicit grant: **Control** (send input, approve, start agents) or **View-only** (read everything, change nothing), for a fixed lifetime; **Personal Control** is a longer grant for a browser only you use, chosen explicitly with `muxr pair --browser-personal`. Installing the app to your home screen grants nothing extra: authority comes from the grant, never from how the window is displayed. The consent screen shows the computer, the role and the exact expiry before you accept.

## Pairing by QR

The QR the computer shows is the one-use pairing link and nothing else. Scanning it in the browser reads the camera image on your device; no frame, code or link is sent anywhere or logged. The interactive demo can scan a QR too, but it only takes you to your computer's own address: the demo site never claims, stores or fetches the invitation. Consent, the claim, key storage and revocation happen only in the browser app served by your computer. A phone's camera app scanning the same QR lands on the same consent screen. An installed Safari app on iPhone is a separate storage partition and needs its own fresh QR.

## Shell authority

A Control grant can type into the agents' terminals and open shells on that computer with your user's permissions. Give Control only to browsers you would sit at; give others View-only.

## Preview and takeover isolation

A previewed dev server runs inside the app in a sandbox with no access to the app's storage, cookies or opener, and it cannot navigate the app; opening a preview URL as a top-level page is refused. One device controls a takeover at a time; a stale or failed controller releases control.

## Revocation

`muxr devices revoke <number|name>` on the computer closes that device's connections immediately, invalidates its unused tickets and rotates the keys the remaining devices use. Expiry does the same on its own schedule. The revoked device sees **Access removed** and must be paired again from the computer to return.

## Provider data

Realtime voice and dictation providers are configured on the computer (`muxr voice`). Audio goes from your device to the provider through your computer's plugin; the app never learns which provider, which account or which key. Coding-agent credentials and model subscriptions are the agents' own and never leave the computer.

## If a device is compromised

A compromised paired browser or phone can reach what its grant allows on the computers it is paired with: those sessions, for that role, until the grant expires or you revoke it. It cannot reach other computers, other devices' keys, the relay's owner secret or anything on the computer beyond the agents' terminals. Revoke it from the computer; nothing else needs to change.

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

Next: [Troubleshooting](troubleshooting.md).
