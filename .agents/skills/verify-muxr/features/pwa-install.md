# Install muxr to the home screen from a browser tab

A person who opens the web client in a browser tab is offered installation.
On Chromium the Settings row hands back the browser's own install prompt; on
iOS Safari, which has no prompt API, the row opens a short Add to Home Screen
guide. The row disappears once the app is installed (or the browser offers no
install path), so nobody is invited to install something already installed.

## Sub-features

- A `beforeinstallprompt` listener is attached at app start (before Settings
  could open) and the held event is returned on tap of the install row.
- Chromium (Android and desktop) with the prompt available: row titled
  `Install muxr`, subtitle `Adds a full-screen app to your home screen.`
- iOS Safari (including iPadOS): row titled `Install muxr`, subtitle
  `Add it to your Home Screen for a full-screen app and alerts.`, opening a
  bottom sheet with the Share → Add to Home Screen steps and the push benefit.
- After the person dismisses Chromium's prompt, the row keeps its place with
  the line `Open your browser menu and choose Install app.` (no tap action); the
  saved prompt cannot be shown twice.
- Hidden on native (`Platform.OS !== 'web'`), when standalone/`appinstalled`,
  and in a browser that offers no install path (a manifest that is not
  installable).

## How to get to it (user POV)

Open the exported web client in a browser tab, open Settings, and go to
Connection & updates. The `Install app` group sits beside the versions card.
Tap it: on Chromium the browser's install dialog appears; on iOS the guide
sheet opens. Install, or confirm the app is already standalone, and the group
is gone.

## Driving it with the private stack

Preconditions: follow `../SKILL.md` Launch only for a private origin if the
real relay is wanted; the install row itself needs the exported build, not a
host. Build and serve the export:

1. `yarn build && yarn web:export:selfhost`, then serve that very
   `apps/mobile/dist` on a free local port with the SPA fallback:
   `MUXR_WEB_PORT=<free> MUXR_WEB_EXPORT_DIR="$PWD/apps/mobile/dist" node scripts/diagnostics/application/serveWebExport.mjs`.
   Keep the port off the owner's 8792 and off any already-listening port.
2. Point chrome-devtools-axi at its own session and open
   `http://127.0.0.1:<free>/settings/connection`. Assert the group renders by
   text `INSTALL APP` / `Install muxr`.
3. Chromium prompt-available: desktop/Android Chrome fires
   `beforeinstallprompt` for this installable export, so the row is present
   without any injection. Capture at 393 and 270 px, light and dark.
4. Installed (standalone): launch a second chrome-devtools-axi session with
   `CHROME_DEVTOOLS_AXI_CHROME_ARGS="--app=http://127.0.0.1:<free>/settings/connection"`.
   `matchMedia('(display-mode: standalone)').matches` is `true`; assert the
   `INSTALL APP` group is absent and the versions row reads `Installed web app`.
   Capture at 393 and 270 px, light and dark.
5. Unsupported: serve the same `dist` from a scratch server that answers 404
   for `/manifest.webmanifest` (Chromium then finds it non-installable and never
   fires `beforeinstallprompt`). Assert the group is absent.
6. iOS guide: set the chrome-devtools-axi user agent to an iPhone Safari string
   (`emulate --user-agent …`), reload, and assert the `Add it to your Home
   Screen` subtitle. Tap the row and assert the guide sheet's `Add muxr to your
   Home Screen`, steps and `Close`. Capture the row and sheet at 393 and 270 px,
   light and dark.

## Gotchas

- `beforeinstallprompt` fires once and is not re-issued for the session; the
  listener must be registered at app start (`_layout.tsx`), not when Settings
  mounts.
- A real iOS Safari pass is still a follow-up device check: user-agent
  emulation in Chromium only proves the state and the guide UI, not a real
  Share menu. iOS Chromium can never install, so its state is the guide or
  `unavailable`, never the prompt.
- `--app=` is what reports `display-mode: standalone`; an ordinary tab does
  not, so the installed proof needs the app window.
- A `maxHeight: '82%'` on a sheet resolves against its own content height in
  the web modal and clips the scroll body; bound it from the window height
  instead and keep the close action out of the scroll area.
- Native is unchanged by construction: `getWebInstallState()` returns
  `unavailable` off web, so no install row ever paints on a phone or tablet build.
- An iOS Safari tab without the Home Screen app also gets the Settings
  Notifications row `Needs muxr on your Home Screen first` instead of a push
  switch; assert it there too.
