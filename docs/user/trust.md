# Trust: what each part can see and do

## End-to-end encryption

Terminal output, keystrokes, prompts, files, attachments and plugin messages are sealed between your computer and the paired device. Browser pages use HTTPS; host-local Browser content passes through a leased HTTPS gateway, and the agent browser uses a private WebRTC connection for viewing and control. Those surface connections have their own transport and are not terminal relay envelopes.

## What the relay sees

The relay routes encrypted terminal/plugin traffic and connection metadata: which device talks to which computer, when and how much. It cannot decrypt that terminal content. A shared relay you operate still sees this metadata; self-hosting does not make metadata disappear.

## Browser access: roles and lifetimes

A browser is paired with an explicit grant: **Control** (send input, approve, start agents) or **View-only** (read everything, change nothing), for a fixed lifetime; **Personal Control** is a longer grant for a browser only you use, chosen explicitly with `muxr pair --browser-personal`. Installing the app to your home screen grants nothing extra: authority comes from the grant, never from how the window is displayed. The consent screen shows the computer, the role and the exact expiry before you accept.

## Pairing by QR

The QR the computer shows is the one-use pairing link and nothing else. Keep the pairing QR or link private: anyone with it can pair a device with the displayed access until it is used or expires. Scanning it in the browser reads the camera image on your device; no frame, code or link is sent anywhere or logged. The interactive demo can scan a QR too, but it only takes you to your computer's own address: the demo site never claims, stores or fetches the invitation. Consent, the claim, key storage and revocation happen only in the browser app served by your computer. A phone's camera app scanning the same QR lands on the same consent screen. An installed Safari app on iPhone is a separate storage partition and needs its own fresh QR.

## Shell authority

A Control grant can type into the agents' terminals and open shells on that computer with your user's permissions. Give Control only to browsers you would sit at; give others View-only.

## Preview and takeover isolation

A host-local Browser surface uses a separate approved origin and a bounded lease. Its application cookies and storage are supported; the gateway strips its own admission cookie before forwarding upstream. Keep the route private and run local applications you trust. A separate port is not a separate cookie boundary.

An agent browser has one controller at a time. During **Take control**, the agent's viewing and input are paused. Leaving or disconnecting can leave **Paused · Private**: the human must choose **Resume control** or **Give back**. **Return to agent** only changes the visible screen. After handback, the agent continues in the same browser context; do not export cookies to transfer the login.

## Revocation

`muxr devices revoke <number|name>` on the computer closes that device's connections immediately, invalidates its unused tickets and rotates the keys the remaining devices use. Expiry does the same on its own schedule. The revoked device sees **Access removed** and must be paired again from the computer to return.

## Provider data

Configure realtime voice on the computer with `muxr voice`; provider credentials stay there. The selected provider receives the audio and requests needed for voice. Transport depends on the provider: audio may pass through the host plugin or use a device-to-provider WebRTC connection. Browser dictation uses the browser's speech-recognition service separately. Coding agents use their own configured model services and credentials.

## If a device is compromised

A compromised paired browser or phone can exercise its grant until expiry or revocation. Control includes shell access with your computer user's permissions; it is not containment to one terminal or repository. Revoke the device from the computer. If it executed commands or exposed credentials, assess those effects too; revoking a grant does not undo them.

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
