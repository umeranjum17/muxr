# Agent browser preview

When a muxr-launched agent opens a page the person should watch or must complete
(sign-in, 2FA/OTP, CAPTCHA, SSO), open it in the normal desktop browser. The
person views that desktop through the phone's Computer action, not a Browser
chip or a private pane screen.

A visible browser grants no extra authorization. Stop for the human at any
password, 2FA/OTP, CAPTCHA, SSO, purchase, publish, destructive, account,
security, or privacy boundary requiring their action or approval.

## Open on the desktop, watch through Computer

1. If this computer has a desktop Computer can show (`$MUXR_AGENT_CAPABILITIES`
   says whether it does), run the browser headed, using that normal desktop
   environment. Do not replace DISPLAY, clear WAYLAND_DISPLAY, or force X11
   browser arguments to create a private screen. If a Chrome fails with a
   Wayland error, add --ozone-platform=x11. If no display is configured for agent
   terminals on this computer, run the browser headless and tell the person
   Computer cannot show it; to show a page on Computer, the host needs DISPLAY or
   WAYLAND_DISPLAY set for muxr.
2. When the browser is headed, tell the person where to look: "Open Computer to
   watch the page or finish signing in." Never paste ports, token-bearing URLs,
   or internal ids.
3. In a Herdr pane, report the wall as blocked so muxr notifies the phone:
   ```sh
   herdr pane report-agent "$HERDR_PANE_ID" --source "$HERDR_PANE_ID" --agent <your-label> --state blocked \
     --message "Sign in needed on example.com — open Computer"
   ```
   Name the site and wall, not page contents or credentials. If HERDR_PANE_ID
   is unset, say that no pane is available to notify rather than guessing an id.
4. While the person is taking over, do not click, type, refresh or navigate.
   Wait for their message before resuming; verify the page has advanced.
5. Report working with the same source and agent values:
   ```sh
   herdr pane report-agent "$HERDR_PANE_ID" --source "$HERDR_PANE_ID" --agent <your-label> --state working \
     --message "Signed in, continuing"
   ```

## Android and iOS device previews

Device previews remain separate from Computer. A headless Android emulator attributed
to this pane appears as a device chip. A windowed emulator stays unannounced;
the person sees it through Computer.
For an iOS Simulator on macOS, boot one you created and run
`muxr preview claim <udid>` in that pane. The simulator chip remains while it
is booted; taps, swipes and Home drive it. Run `muxr preview release` when done.

Before touching a device preview, check `muxr preview status`. While it prints
`human`, the person is driving: no clicks, typing, refresh or navigation. Wait
for their message or check at most every 30–60 seconds. This command reports a
device-preview lease, not permission to act in the normal desktop browser.

On a headless server, Computer's fallback is not a claim that a normal desktop
browser is available. Report the missing desktop plainly; do not route an
unknown or retired Browser target to the real desktop.
