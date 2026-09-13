# Surfaces: Browser, Code and terminal tools

## Open from the owning pane

Use the live Herdr pane and its real worktree. The host resolves context and provider;
a stale pane, unrelated directory or ambiguous provider fails visibly.

```bash
muxr browser open https://example.com/guide
muxr browser open http://localhost:3000/app
muxr browser home
muxr code open src/main.ts:20
muxr code diff
muxr surface list
```

Browser can open public HTTPS, a host-local HTTP app through a leased private HTTPS
endpoint, or a blank page. Remote plain HTTP, credentialed URLs, file/debug schemes
and paths outside the permitted worktree are rejected. Code opens review targets;
it does not grant file-editing authority. `--name NAME` selects a logical surface;
`--provider ID` resolves an actual provider ambiguity. `--beside`/`--focus` express
placement, and do not override the controlling device's foreground preference.

Use `muxr browser update URL --name NAME`, `muxr browser reload --name NAME` and
`muxr browser close --name NAME` for the selected Browser surface. The host owns
local endpoints and routes; never ask the phone user to type a broker port or secret.
For the agent's existing login context, use the separate
[browser-session handoff](browser-takeover.md), not a new WebView.

## Where the controls are

The terminal's footer **Tools** contains open Browser/Code surfaces, declared quick
actions such as Files/Changes/Applications, **Find in recent output** and link actions.
It dismisses the keyboard before opening and leaves the unsent draft in place.
Terminal sheets follow the session's dark surface. The header **Pane actions**
keeps inspection, layout, closing and other occasional actions.

A surface's **Return to agent** returns to the same terminal. In an agent browser,
**Give back** separately returns control; leaving a private browser can pause it.
Rotation refits the surface; it does not transfer ownership or submit text.

## Find retained output

Choose **Tools → Find in recent output**. One host read supplies recent unwrapped
output, capped at 1,000 lines and 256 KiB. The query is trimmed, case-insensitive
literal text, not regex. Up to 200 matching lines are shown with one adjacent line
on either side; overlapping context is combined. The sheet states retained count,
capture time and truncation. It is not an archive or full conversation search.

**Refresh** deliberately requests another snapshot. Typing makes no host request.
A failed refresh keeps the old snapshot and its time. **Done** or dismissal drops
the query/snapshot; Return only dismisses the keyboard. Search does not send input,
move the live terminal or rewrite the draft.

## Focus the same pane in Herdr

Use **Pane actions → Focus in Herdr** with a Control grant and a live connection.
The request selects that workspace/tab/pane in Herdr. The menu remains open while
pending and reports failure for an explicit retry. **Focused in Herdr** appears
after success. This does not launch Herdr or raise/focus an OS desktop window.

## Symptom → cause → command

| Symptom | Cause to check | Command / next action |
|---|---|---|
| Browser/Code is absent from Tools | No offer in this pane, missing capability/provider, or approval needed | `muxr surface capabilities`, then `muxr surface list` from the owning pane; open the actual target there. |
| Local app stopped answering | Upstream dev server stopped or its lease/generation changed | Restore that dev server, then `muxr browser open http://localhost:3000/app` from its pane, using its real port. A relay restart does not restart the app. |
| Surface expired, closed or replaced | The previous handle is no longer valid | List current surfaces; reopen the intended target once and use its new offer. |
| No matching text in this snapshot | Query does not match retained lines | Change the literal query or **Refresh**. Older output and a complete transcript are outside this search. |
| First 200 matches shown | Query is too broad | Narrow the query; there is no automatic next page of matches. |
| Refresh failed | Host read failed; displayed data may be old | Read the capture time, restore the connection, then press **Refresh** once. |
| Could not focus / Not connected | Focus request failed or the host disconnected | Restore the connection and deliberately retry **Focus in Herdr**. Repeated automatic focus is not a recovery. |

Keep broker addresses, internal identifiers, capabilities and credentials out of
agent replies. Report logical surface names and the actual outcome.
