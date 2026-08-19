---
name: "browser-takeover"
description: "Hand a stuck browser session to the user's phone when agent-browser automation hits a login / 2FA / CAPTCHA wall — enable the stream, report blocked with the port, then STOP and wait for the human instead of clicking."
version: 1
created: "2026-08-19"
updated: "2026-08-19"
---
## When to Use
Use the moment browser automation (agent-browser) hits a wall only a human can clear: a login form, a 2FA/OTP prompt, a CAPTCHA, an SSO redirect, a "verify it's you" interstitial. You know you are stuck — announce it; do not wait for anyone to notice, and do not try to detect the wall with heuristics. Not for ordinary errors you can retry your way out of.

## Procedure
1. Enable the live stream so the phone can see the page. Note the port — you MUST put it in the blocked message, it is the only way the phone finds the stream:
   `agent-browser stream enable --json` → read the port (OS-assigned). Pin it with `--port <N>` or `AGENT_BROWSER_STREAM_PORT` if you need a stable number.
   If you run agent-browser with `--session <name>`, pass `--session <name>` here too and include the session name in the message.
2. Report blocked through herdr (muxr reads this and pushes a notification to the phone):
   ```
   herdr pane report-agent "$HERDR_PANE_ID" --source "$HERDR_PANE_ID" --agent <your-label> --state blocked \
     --message "2FA on appstoreconnect.apple.com — takeover stream port 9222"
   ```
   Name the SITE and the WALL ("login on …", "CAPTCHA on …"), then the port. Never include page contents, URLs with tokens, or credentials in the message.
3. **STOP. Do not click, type, refresh, or navigate while the human may be typing a code.** One extra click can destroy an half-entered 2FA or trip a rate limit that locks the account. Wait: poll the page state no more than every 30–60s, or simply wait for the user to message you.
4. When the wall is cleared (the page advanced past it), hand the stream back and resume:
   `agent-browser stream disable`, then
   `herdr pane report-agent "$HERDR_PANE_ID" --source "$HERDR_PANE_ID" --agent <your-label> --state working --message "takeover done, continuing"`
   Continue the original task.
5. Make it the last time: if the user logged in manually, persist the auth so the wall never appears again —
   `agent-browser state save <site>.json` (lands in `~/.agent-browser/sessions/`; `chmod 600` it, it holds plaintext session tokens), and on future runs start with `--restore` / `--session <name> --restore` or `AGENT_BROWSER_RESTORE`. The phone app also offers this after a takeover; don't duplicate it if the user already saved.

## Pitfalls
- Forgetting the port in the blocked message leaves the phone with no way to connect — always include it.
- `report-agent` needs `--source` and `--agent` every time; reuse the same values for the working/blocked pair so the phone can correlate them.
- Do NOT keep automating while blocked. Waiting is the protocol; the human is typing credentials into the very page you would be clicking on.
- The stream port is loopback-only and reached from the phone through the muxr relay tunnel. Never bind it wider, never print cookies/page content into logs, and never type the user's password or 2FA code yourself — that is the human's job, that is the whole point.
- State files are plaintext session tokens: `chmod 600`, never commit them, never paste their contents.
- If HERDR_PANE_ID is unset you are not in a herdr pane — there is no phone to take over; say out loud that you are blocked instead.

## Verification
1. `agent-browser stream status` shows the stream server enabled on the port you announced (and disabled after you resume).
2. The phone shows the pane blocked with your message; the user opens the takeover screen, sees the live page, and clears the wall by touch.
3. `agent-browser state list` shows the saved state file after step 5; a fresh `--restore` run does not hit the wall again.
