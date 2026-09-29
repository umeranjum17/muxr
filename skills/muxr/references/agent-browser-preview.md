# Agent browser preview

Use this when a muxr-launched agent opens a page the user should watch or must
complete themselves (sign-in, 2FA/OTP, CAPTCHA, SSO). There is no in-app Browser:
the agent's browser runs headed on its pane's own screen, and the phone shows a
live chip in the session header while it is there. Tapping the chip (Watch)
opens the live view; the first tap on the picture takes control, and Hand back
returns it. On iPhone, use the web app; the native iOS client does not offer it.

A visible browser grants no extra authorization. Stop for the human at any
password, 2FA/OTP, CAPTCHA, SSO, purchase, publish, destructive, account,
security, or privacy boundary requiring their action or approval.

## Open for the chip, not for Computer

1. Run browsers headed (not headless) so the pane's screen has something to
   show: a headless browser never raises the chip. If a Chrome fails with a
   Wayland error, add --ozone-platform=x11.
2. Tell the user where to look: "Your agent opened a browser — tap the browser
   chip to watch." Never paste ports, token-bearing URLs, or internal ids.
3. In a Herdr pane, report the wall as blocked so muxr notifies the phone:
   ```sh
   herdr pane report-agent "$HERDR_PANE_ID" --source "$HERDR_PANE_ID" --agent <your-label> --state blocked \
     --message "Sign in needed on example.com — tap the browser chip"
   ```
   Name the site and wall, not page contents or credentials. If `HERDR_PANE_ID`
   is unset, say that no pane is available to notify rather than guessing an id.
4. Before touching the browser, check `muxr preview status`: while it prints
   `human` the person is driving — no clicks, typing, refresh, or navigation.
   Wait for their message or check at most every 30–60 seconds.
5. Verify the page has advanced before resuming, then report working with the
   same source and agent values:
   ```sh
   herdr pane report-agent "$HERDR_PANE_ID" --source "$HERDR_PANE_ID" --agent <your-label> --state working \
     --message "Signed in, continuing"
   ```

The phone's Computer action still shows this computer's own desktop; it is not
the agent pane's browser. If the page must run on the machine's desktop
instead, open it in that desktop's normal browser and say so plainly.
