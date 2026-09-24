# Browser work the user can see and take over

## When to use

Use this when a muxr-launched agent needs a web page the user should watch, or
a page only the user can get past (sign-in, 2FA/OTP, CAPTCHA, SSO).

muxr has no separate in-app browser. The phone's **Computer** action shows and
drives this computer's real desktop, so open pages in the computer's normal
desktop browser: the user sees the same window, with their own profile,
cookies, and password manager, and can take over by touch.

A visible browser is not extra authorization. Keep the requested view/control
boundary, and stop for the human at a password, 2FA/OTP, CAPTCHA, SSO, purchase,
publish, destructive, account, security, or privacy boundary that requires
their action or approval.

## Open a page on the desktop

1. Open the page in the default desktop browser: `xdg-open <url>` on Linux,
   `open <url>` on macOS. It lands in the browser the user already uses, on the
   screen Computer shows.
2. Tell the user where to look in plain words ("Open Computer on your phone;
   the sign-in page is up"). Never paste ports, token-bearing URLs, or ids.
3. If you must drive the page yourself, keep the window on the desktop (for
   example a headed `agent-browser` session) rather than a headless browser the
   user cannot see. Do not open a second copy of a page the user is already on.

## Hand control to the human

1. Report blocked through Herdr; muxr reads this and notifies the phone:
   ```
   herdr pane report-agent "$HERDR_PANE_ID" --source "$HERDR_PANE_ID" --agent <your-label> --state blocked \
     --message "Sign in needed on example.com — open Computer"
   ```
   Name the site and wall. Never include page contents, token-bearing URLs,
   credentials, ports, or internal ids.
2. **Stop browser input while the human may be typing.** Do not click, type,
   refresh, or navigate the desktop. Poll no more than every 30–60 seconds, or
   wait for the user's message.
3. After the page advances, report working with the same source and agent
   values:
   ```
   herdr pane report-agent "$HERDR_PANE_ID" --source "$HERDR_PANE_ID" --agent <your-label> --state working \
     --message "Signed in, continuing"
   ```

## Pitfalls

- `HERDR_PANE_ID` must be present. Without a Herdr pane there is no muxr
  session to notify; say that plainly instead of guessing an id.
- A headless browser is invisible in Computer. If the user has to see or touch
  the page, it has to be a window on the desktop.
- Computer needs a control-paired phone and a desktop session on this computer.
  When the user cannot open it, fall back to asking them to finish the step at
  the computer itself.
- `report-agent` needs `--source` and `--agent` on every update; reuse the same
  values for the blocked/working pair.

## Verification

1. The page is open in the desktop browser and visible through Computer.
2. After the handoff, the page has advanced and the agent resumed only then.
