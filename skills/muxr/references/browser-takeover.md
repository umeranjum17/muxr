# Shared browser and human takeover

## When to use

Use `agent-browser` for browser work in a muxr-launched Herdr pane. It owns the
same browser session that muxr's Browser view displays, so the user can watch or
take over without a second browser, copied state, or a port in chat.

A visible browser is not extra authorization. Keep the requested view/control
boundary, and stop for the human at a password, 2FA/OTP, CAPTCHA, SSO, purchase,
publish, destructive, account, security, or privacy boundary that requires
their action or approval.

## Drive the shared browser

1. Open or reuse the page with `agent-browser open <url>` (include the same
   `--session <name>` on every command when using a named session).
2. Drive that session normally with `agent-browser snapshot -i`, then its
   current refs for click/fill/type. Re-snapshot after navigation. Do not launch
   a parallel browser: muxr's Browser entry attaches to this session.
3. The Browser screen enables the loopback stream itself. Every session is
   born with its stream server bound: `agent-browser stream enable --json`
   always answers "Streaming is already enabled for this session" (exit 1),
   with or without a browser. Query `agent-browser stream status --json` and
   reuse its bound port, but check `data.connected`: a bound port with
   `connected: false` has no live browser behind it and will never stream a
   frame — open the browser first. Never replace, expose, or disable a stream
   another viewer enabled.

## Hand control to the human

1. When a human-only wall appears, make the loopback stream live using the
   status/`connected` check from “Drive the shared browser” above: the stream
   server is always bound, so `stream enable` alone proves nothing.
2. Report blocked through Herdr; muxr reads this and notifies the phone:
   ```
   herdr pane report-agent "$HERDR_PANE_ID" --source "$HERDR_PANE_ID" --agent <your-label> --state blocked \
     --message "Sign in needed on example.com"
   ```
   Name the site and wall. Never include page contents, token-bearing URLs,
   credentials, ports, or internal ids.
3. **Stop browser input while the human may be typing.** Do not click, type,
   refresh, or navigate. Poll no more than every 30–60 seconds, or wait for the
   user's message.
4. After the page advances, disable the stream only if your successful enable
   created it. Then report working with the same source and agent values:
   ```
   herdr pane report-agent "$HERDR_PANE_ID" --source "$HERDR_PANE_ID" --agent <your-label> --state working \
     --message "Signed in, continuing"
   ```
5. If the user logged in manually, persist the session once with
   `agent-browser state save <site>.json`, then `chmod 600` the file under
   `~/.agent-browser/sessions/`. Use `--restore` on later runs. Do not duplicate
   this if the Browser view already saved it.

## Pitfalls

- `HERDR_PANE_ID` must be present. Without a Herdr pane there is no muxr
  terminal/browser context; say that plainly instead of guessing an id.
- The stream is loopback-only and reaches the user through muxr's existing
  tunnel. Never widen the bind or paste its port into a message.
- Saved state contains plaintext session tokens. Keep it mode 600, never commit
  it, and never print it.
- `report-agent` needs `--source` and `--agent` on every update; reuse the same
  values for the blocked/working pair.

## Verification

1. `agent-browser stream status --json` reports the existing stream when one is
   enabled; a repeated enable does not create another.
2. muxr's Browser view shows the page from the same session and accepts touch
   input without copying cookies or opening another browser.
3. After takeover, the page has advanced and the agent resumes only then.
4. A saved-state flow restores without exposing the state file or repeating the
   human-only wall.
