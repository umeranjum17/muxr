# Browser takeover for login, 2FA, and CAPTCHA

Use the browser session the agent will continue using after the human signs in.
Ordinary `muxr browser open` opens a separate Browser surface; it does not transfer
an agent's authenticated context. A raw agent-browser stream is not this handoff.

## Open the session and request help

From the owning Herdr pane, use a logical name:

```bash
muxr browser session open --name login
muxr browser session navigate https://example.com --name login
muxr browser session snapshot --name login
```

When a login, 2FA or CAPTCHA needs the human:

```bash
muxr browser session help --name login
```

Tell the human which site needs help, without including a token-bearing URL or any
private page text. The session appears under the terminal's **Tools** surfaces.
The human opens it and chooses **Take control**. Provider ambiguity or a missing
private browser service is a visible failure; never substitute a guessed port,
raw CDP endpoint, cookie export or a new browser and call it the same session.

## While the human controls it

Wait. Do not navigate, click, fill or keep taking snapshots during private control.
The ownership strip says the agent's input and viewing are paused. Credentials are
entered by the human in the controlled browser, not supplied to an agent command.
The agent API supplies bounded semantic actions, not arbitrary evaluation or
cookie/profile export. Use `fill` only for ordinary non-secret fields.

Leaving the surface, backgrounding or disconnecting can leave **Paused · Private**.
It does not automatically return control. On the cover, the human chooses
**Resume control** or **Give back**. **Return to agent** changes the visible screen;
it is not a browser-ownership handback.

## Continue only after Give back

The human explicitly chooses **Give back**. Wait for the handback to complete, then
inspect the same named session:

```bash
muxr browser session snapshot --name login
```

Continue the original task through `navigate`, `click`, `fill` and `scroll` on that
session. Do not save/export cookies to make login “persist”: the authenticated
context stays with the browser service. Close with
`muxr browser session close --name login` only when the work is finished.

## Symptom → cause → command

| Symptom | Cause to check | Command / next action |
|---|---|---|
| No surface for the expected session | Wrong pane/context, missing provider, or no open session | Run `muxr surface list` from the owning pane; use `muxr browser session open --name login` only if it is absent. |
| Agent action is denied during sign-in | Human owns the private session | Wait for **Give back**. Do not retry commands against a private session. |
| Paused · Private | Ownership remains with the human after leaving or losing the connection | Human chooses **Resume control** or **Give back** on the existing surface. |
| Session ended or needs pairing | Lease/session ended or device authority changed | Follow the displayed recovery; pair the device again only when requested. Reopening a closed session does not promise its old authentication. |
| Ordinary Browser opens but login context is missing | A WebView surface was used instead of the agent session | Return to the named agent browser under **Tools**. Do not copy credentials between the two. |

Verify by continuing the original action in the same named authenticated session
after explicit handback. A visible login page or successful browser launch alone
is not that proof.
