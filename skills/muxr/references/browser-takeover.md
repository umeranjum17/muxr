# Browser work the user can see and take over

## When to use

Use this when a muxr-launched agent needs a web page the user should watch, or
a page only the user can get past (sign-in, 2FA/OTP, CAPTCHA, SSO).

muxr has no separate in-app browser. On a machine with a desktop session,
the phone's **Computer** action shows and drives that desktop. Open pages in
its desktop browser so the user sees the same window and can take over by touch.
On iPhone, open Computer in the web app; the native iOS client does not offer it.

A visible browser is not extra authorization. Keep the requested view/control
boundary, and stop for the human at a password, 2FA/OTP, CAPTCHA, SSO, purchase,
publish, destructive, account, security, or privacy boundary that requires
their action or approval.

## Open a page on the desktop

1. On a supported Linux machine with a desktop session, open the page in that
   session's default desktop browser: `xdg-open <url>`. Check that the window
   is on the screen Computer shows before handing off.
2. Tell the user where to look in plain words ("Open Computer on your phone;
   the sign-in page is up"). Never paste ports, token-bearing URLs, or ids.
3. If you must drive the page yourself, keep its window on that desktop
   rather than in a headless or separate browser session the user cannot see.
   Do not open a second copy of a page the user is already on.

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
  An agent pane on a screenless host does not inherit the private virtual
  display's environment; opening a URL there does not hand it to Computer.
  When the page is not visible through Computer, ask the user to finish the
  step on their own device.
- `report-agent` needs `--source` and `--agent` on every update; reuse the same
  values for the blocked/working pair.

## Verification

1. The page is open in the desktop browser and visible through Computer.
2. After the handoff, the page has advanced and the agent resumed only then.
