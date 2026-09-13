# Onboarding: install, configure, pair, maintain

Run the relay and host on the computer you control. The browser app uses that
computer's private HTTPS origin; native apps are optional. Voice providers make
their own external requests. This guide and the [configuration reference](configuration.md)
are the same sources used by the user docs; do not invent a second config inventory.

## Install

Use Herdr 0.8.0+ on Linux/macOS (WSL needs a systemd user session), or Node 22+
for npm. The Herdr control plugin records the verified muxr executable it installed;
its Setup/Pair/Doctor/Service panes use that executable.

<!-- herdr-commands:start -->
```text
herdr plugin install umeranjum17/muxr/plugins/control --ref v0.1.28
herdr plugin pane open --plugin muxr.control --entrypoint setup
```
<!-- herdr-commands:end -->

Without Herdr, install the CLI; setup can install Herdr:

<!-- npm-commands:start -->
```bash
npm install -g --ignore-scripts @trymuxr/cli@latest
muxr
```
<!-- npm-commands:end -->

npm installs files; running `muxr` begins setup. Setup inspects the machine,
proposes one recommended browser-capable
route when one is available, and offers **Choose another way**, then **Review**
and **Apply setup**.
Review names the changes; do not assume Cancel is preselected. Use a private HTTPS
route for the browser. The route alias is `MUXR_CONNECTION`;
tailscale-direct, private and lan are native-only.
Keep other applications' listeners and Serve mappings intact.

## Configure beside installation

```bash
muxr config
muxr config --schema
muxr setup --inspect
```

Version-2 `selfhost.json` separates editable desired fields from generated `runtime`.
It contains credentials, so the whole file stays private. `muxr config export`
prints only stored desired fields. Legacy `config.env` beside version 2 is a conflict.
Read [what changes can do now](configuration.md#what-a-change-can-do-now): the
`config set/apply` commands are still unavailable, and a saved value is not proof
that its complete lifecycle change succeeded. The existing planner is
`muxr setup --apply-config --dry-run --json` (exit 2 for a valid change plan).

`MUXR_HOME` alone does not isolate a managed service. Before a second installation,
restart or uninstall, check [service ownership and short socket paths](configuration.md#service-ownership-and-a-second-instance).
Do not use an internal test bypass as an operator recipe. Setup installs no skills
and edits no agent prompt files.

## Pairing handoff

```bash
muxr pair --browser            # Control
muxr pair --browser-view       # View-only
muxr pair --browser-personal   # Personal Control on a browser you own
muxr pair --native             # native app, until revoked
muxr devices list
```

Every invitation is a credential: keep its QR/link private. It is single-use and
short-lived; the pairing screen renews expired invitations. Lifetimes are listed below. The consent screen
names the computer, access and actual expiry; scanning alone grants nothing.
Open the link in the browser that will use it. On iOS, an installed PWA has its
own storage and needs a separate pairing from the Safari tab. Use
`muxr devices revoke <number|name>` only for an intentional authorization change.

Verify the actual device: run `muxr doctor`, open a real session and confirm live
output. Browser expiry, version mismatch and device revocation have different
recoveries; a QR, saved grant or desktop build alone proves none of them.

## Work in the terminal

**Tools** sits in the terminal footer. It opens the session's Browser/Code surfaces,
Files, Changes, Applications and link actions; opening it dismisses the keyboard
and preserves the unsent draft. The header **Pane actions** contains occasional,
layout and destructive actions. Terminal sheets use the session's dark surface.

**Tools → Find in recent output** searches a host snapshot, not the visible terminal
buffer or a complete conversation. It keeps up to 1,000 lines / 256 KiB, searches
literal text without case sensitivity, and shows at most 200 matches with adjacent
lines. **Refresh** reads again; typing does not. A failed refresh retains the old
snapshot and its timestamp. **Done** returns without sending input or scrolling
the live terminal. **Pane actions → Focus in Herdr** selects the same pane on the
computer, requires Control and a connection, and does not raise an OS window.

Use [surfaces](surfaces.md) for Browser/Code commands and
[browser takeover](browser-takeover.md) for a login or 2FA handoff to the same
agent browser. **Return to agent** changes the visible surface; **Give back** is
the separate browser-control handback.

## Diagnose: symptom → cause → command

Start with `muxr doctor` for current health and `muxr diagnostics` for recent
redacted events. Use the symptom below to choose the next action.

| Symptom | Cause to check | Command / next action |
|---|---|---|
| Computer offline | Host asleep, network disconnected or service stopped | `muxr daemon status`, then `muxr doctor`. Restart only the failed service whose executable/state path you verified with `muxr restart`. |
| Config edit has no visible effect | Pending desired value, higher-priority source, or unsupported change path | `muxr config --json`, then [configuration recovery](configuration.md#troubleshooting). |
| Serve root occupied | Another application owns HTTPS | `tailscale serve status --json`; keep the mapping and choose another private route. Never reset a foreign Serve root. |
| Pairing expired/revoked | Invitation expired or authority removed | Run the matching pairing command above for a fresh authorized invitation. A retry alone cannot undo revocation. |
| No matching output | Text is absent from the retained snapshot | Narrow the literal query or tap **Refresh**; older output is not included. |
| Could not focus | Connection or host focus request failed | Reconnect, then deliberately retry **Focus in Herdr**. No automatic replay occurs. |
| Browser is Paused · Private | Human control remains held after a disconnect or leaving the surface | The human chooses **Resume control** or **Give back**. The agent waits. |

## Shared relay, maintenance and removal

`muxr shared-relay` hosts a relay; `muxr machines enroll` creates a one-use,
short-lived invitation. Use `muxr connect --enrollment '<enrollment>'` on the other
computer; never copy relay-owner authority or `runtime` to enroll it.

`muxr update --check` is read-only; `muxr update` updates the host and its registered
runtime, not the phone app. `muxr doctor` checks health, `muxr diagnostics` shows
bounded redacted history, and `muxr report` prints a local draft. Review that draft
and obtain explicit posting authorization before an agent submits anything.

`muxr uninstall` removes muxr-owned identity, grants, provider keys, services and
runtime. It keeps Herdr, sessions, repositories, worktrees and received attachments.
It is not first aid for a config or version warning.

<!-- release-facts:start -->
| Fact | Value |
|---|---|
| Current release | `@trymuxr/cli@0.1.28` (tag `v0.1.28`) |
| Minimum Herdr | 0.8.0 |
| Minimum Node (npm path) | 22 |
| Default relay port | 8792 |
| Pairing link | one use, expires in 2 minutes |
| Browser access (Control or View-only) | 8 hours |
| Personal Control (installed browser you own) | 30 days |
| Machine enrollment (shared relay) | 5 minutes |
| Native apps | optional: [Android APK](https://trymuxr.com/downloads/stable/android) ([checksums](https://trymuxr.com/downloads/stable/checksums)), [Google Play testing](https://play.google.com/apps/testing/com.trymuxr.app), [iOS TestFlight](https://testflight.apple.com/join/aJSbs8pN) — availability depends on store review; [all channels](https://trymuxr.com/downloads) |
<!-- release-facts:end -->
