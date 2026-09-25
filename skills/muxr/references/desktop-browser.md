# Desktop browser handoff through Computer

Use this when a muxr-launched agent opens a page the user should watch or must
complete themselves (sign-in, 2FA/OTP, CAPTCHA, SSO). There is no in-app Browser:
the phone's **Computer** action shows and drives the machine's desktop browser.
On iPhone, use Computer in the web app; the native iOS client does not offer it.

A visible browser grants no extra authorization. Stop for the human at any
password, 2FA/OTP, CAPTCHA, SSO, purchase, publish, destructive, account,
security, or privacy boundary requiring their action or approval.

## Open and hand off

1. On a machine with a desktop session, open the page in its normal browser
   (`xdg-open <url>` on Linux). Check that it is visible in Computer, not in a
   headless or separate browser. Do not open a second copy of the user's page.
2. Tell the user where to look: “Open Computer on your phone; the sign-in page
   is up.” Never paste ports, token-bearing URLs, or internal ids.
3. In a Herdr pane, report the wall as blocked so muxr notifies the phone:
   ```sh
   herdr pane report-agent "$HERDR_PANE_ID" --source "$HERDR_PANE_ID" --agent <your-label> --state blocked \
     --message "Sign in needed on example.com — open Computer"
   ```
   Name the site and wall, not page contents or credentials. If `HERDR_PANE_ID`
   is unset, say that no pane is available to notify rather than guessing an id.
4. Stop browser input while the human may be typing: no clicks, typing, refresh,
   or navigation. Wait for their message or check at most every 30–60 seconds.
5. Verify the page has advanced before resuming, then report working with the
   same source and agent values:
   ```sh
   herdr pane report-agent "$HERDR_PANE_ID" --source "$HERDR_PANE_ID" --agent <your-label> --state working \
     --message "Signed in, continuing"
   ```

Computer needs a control-paired phone and a desktop session on this computer.
A screenless host's private display is not the agent pane's desktop. If the
page is not visible through Computer, ask the user to finish on their device.
