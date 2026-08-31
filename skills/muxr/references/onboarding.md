# Onboarding: install, pair, self-host, maintain

Everything muxr does runs on your own infrastructure: the relay, the agent
host, and the pairing between them and the app.

## Contents

[Prerequisites](#prerequisites) · [Install](#install) · [First run](#first-run) ·
[Connection choices](#connection-choices) · [Pairing](#pairing) ·
[Shared relay](#shared-relay-on-a-vps) · [Maintenance](#maintenance) ·
[Recovery](#diagnose-and-recover) · [Report](#report-an-issue) ·
[Uninstall](#uninstall) · [Verify](#verify)

## Prerequisites

- Node 22+ on the machine that runs your agents (Linux, macOS, WSL).
- Herdr: if missing, setup installs and verifies it automatically.
- The muxr app on your phone (TestFlight, Google Play internal testing, or the
  signed Android APK on GitHub Releases).

## Install

```bash
npm install -g --ignore-scripts @trymuxr/cli
muxr
```

The convenience installer at
`https://raw.githubusercontent.com/umeranjum17/muxr/main/install.sh` performs
that same npm install without `sudo`; it requires Node 22+ and does not install
Node itself.

## First run

Run `muxr` with no arguments for the interactive setup and maintenance menu.
The onboarding inspects the machine without changing it. You choose the
connection method, local port or external URL, whether to host the
control/view-only web client, agent integrations, optional plugins, and managed
services. Nothing changes before a final **Apply setup** confirmation. Setup
then starts the selected relay and host, runs the pairing flow (scan the
one-use QR from the phone app), and verifies the connection and managed
services without printing credentials.

Setup never installs skills or edits agent instruction files. Run `muxr --skill`
for the compact workflow, then `muxr skill onboarding` only when this reference
is needed. Lifecycle integrations only report agent process status.

The registered user service supervises the relay and host together, so both
return after login or reboot. Preview managed-file changes anytime with
`muxr setup --dry-run`.

## Connection choices

Interactive onboarding presents these; the automation equivalents are flags on
`muxr self-host`:

| Choice / flag | What happens |
|---|---|
| `--advertise <url>` | Explicit relay URL wins. Use your own domain/reverse proxy. |
| `--tunnel` | Spawns `cloudflared` for a public `trycloudflare.com` URL. Ephemeral; use a named tunnel for permanence. |
| Tailscale Serve | Private HTTPS through `tailscale serve`; the relay stays on loopback. |
| `--tailscale-direct` | Rollback path using the tailnet IP directly. |
| Local network | LAN address. Phone must be on the same wifi. |

muxr never enables Tailscale Funnel. Restrict a Serve endpoint with a tailnet
grant/ACL even though pairing and E2EE remain authoritative. `--web` requires a
secure `wss://` route; insecure LAN HTTP is refused. Set `MUXR_TRUST_PROXY=1`
when the relay sits behind cloudflared/nginx so rate limits key on real client
IPs.

Session, terminal, attachment, and plugin-stream payloads use the strict E2EE
data plane; the relay routes ciphertext it cannot read.

## Pairing

- Native pairing is single-use and expires in two minutes. QR and manual entry
  use the same short relay-qualified string. Run `muxr pair` anytime for a
  fresh QR.
- The phone proves itself once and receives a durable device credential. It
  stays paired until explicit revocation; calendar time never forces another QR.
- `muxr pair --browser` grants full terminal and agent control from a browser;
  `muxr pair --browser-view` grants explicit view-only access. Both print one
  short two-minute HTTPS link, expire after eight hours, and survive
  refresh/restart.
- List and revoke devices — never edit relay state by hand:

  ```bash
  muxr devices list
  muxr devices revoke 2       # list number, or an unambiguous friendly name
  ```

  Revocation immediately closes that device's sockets and credential and
  rejects its unused tickets.

## Shared relay on a VPS

For one relay serving several machines, run interactive `muxr` on the VPS and
choose **Host or change a shared relay**. The VPS runs only the supervised
relay; it does not need Herdr or an agent host. Automation equivalents:

```bash
muxr shared-relay
muxr machines enroll|list|revoke
muxr connect --enrollment <muxr://enroll?...> [--no-pair|--pair-browser|--pair-both]
```

Enrollment strings are single-use and expire after five minutes. They contain
the relay URL plus one-time bootstrap material, never relay-owner authority.
Machine keys are created locally on each agent machine; the relay returns only
a credential scoped to that machine. Revoking a machine disconnects its host
and devices and cannot affect another enrolled machine.

Changing a relay endpoint requires fresh pairing because devices pin the
endpoint from their pairing grant. Plugin and agent changes sync live.

## Maintenance

```bash
muxr update                    # check, confirm, update, and restart
muxr update --check            # check without changing anything
muxr doctor                    # current setup health and checked repairs
muxr diagnostics               # bounded redacted host/client history
muxr report > muxr-report.md   # local redacted issue draft; never submits
muxr daemon status|logs|start|stop|restart
muxr setup --dry-run           # preview managed-file changes
```

muxr state lives under `~/.muxr` unless `MUXR_HOME` is set.

## Diagnose and recover

Use the checked recovery path before changing files or reinstalling:

1. Run `muxr doctor` in an interactive terminal. It checks the runtime, Herdr,
   integrations, managed files, service registration, relay, connection,
   pairing, and local peer access. When a failed check has a known safe repair,
   doctor lists the repair and asks before running it.
2. Approve only the repairs doctor offers, then rerun `muxr doctor`. A repair is
   not complete until the failing check becomes healthy.
3. Run `muxr diagnostics` for seven days of bounded, redacted host/client/relay
   history. Redirect this JSON when escalation is needed. Review `muxr doctor`
   output before posting it because connection names or addresses may be local.
4. Use `muxr daemon logs` only for local diagnosis; review it before sharing.

If setup appears stuck, press Ctrl-C. Setup can be rerun and now prints its
current network, relay, or service phase; each non-interactive dependency has a
bounded deadline. Then follow the matching remedy:

| Failed phase or doctor check | Safe next action |
|---|---|
| Herdr server or lifecycle integrations | accept doctor's offered repair, or run `muxr integrations sync`; rerun doctor |
| muxr service, relay, or local peer access | `muxr daemon restart`, then `muxr doctor` |
| Tailscale Serve | if Tailscale says Serve is not enabled, use its printed `login.tailscale.com` link or the Tailscale admin console to enable Serve, then rerun setup; otherwise choose LAN / `muxr self-host --tailscale-direct`. Restart `tailscaled` only when another connection can survive the interruption. |
| Local relay port | `curl --max-time 3 http://127.0.0.1:8792/health`; inspect the owner with `ss -ltnp 'sport = :8792'` on Linux or `lsof -nP -iTCP:8792 -sTCP:LISTEN` on macOS; stop only a process you recognize or rerun `muxr setup --port <free-port>` |
| Expired or interrupted pairing | `muxr pair` for a new single-use code |
| Connection choice or tunnel | rerun interactive `muxr`; do not edit `~/.muxr` |

On Linux, a Tailscale daemon stall can be confirmed without waiting forever:

```bash
timeout 15s tailscale status --json
timeout 15s tailscale serve status --json
```

Exit status `124` means the local Tailscale command timed out. Capture
`journalctl -u tailscaled -b --no-pager` locally before restarting it. Do not
restart `tailscaled` from a session reachable only through Tailscale.

Do not delete or hand-edit `~/.muxr` as a repair. If doctor reports corrupt or
incomplete state, stop and back up the exact file it names before moving it
aside; that state contains machine identity and pairing authority. `muxr
uninstall` is destructive recovery, not first aid.

## Report an issue

Create one local draft instead of collecting commands by hand:

```bash
muxr report > muxr-report.md
```

`muxr report` works even when first setup never completed or host diagnostics do
not exist. It includes muxr, Node, OS/kernel, Herdr, and Tailscale versions; only
the names and states of doctor checks; and at most the latest 50 events from the
bounded redacted diagnostic journal. It never includes prompts, terminal/file
content, paths, credentials, keys, raw daemon logs, or internal ids. The command
only writes the draft; it never opens or submits an issue.

Before any post:

1. Read the complete draft and fill in What happened, Steps to reproduce, and
   Expected behavior.
2. Show the complete title and body to the user. Do not summarize away fields
   they need to review.
3. Ask explicitly whether they want to post that exact draft.
4. Take no browser, GitHub CLI, or API action unless they answer yes. Asking to
   diagnose, summarize, or prepare a report is never approval to post.

If they prefer to submit it themselves, give them the Bug form URL:
`https://github.com/umeranjum17/muxr/issues/new/choose`.

## Uninstall

`muxr uninstall` removes every muxr-owned operational component — including
machine identity, pairings, grants, provider keys, runtime state, services,
ingress, and managed integrations — then optionally removes the global CLI. It
keeps Herdr, Herdr sessions, repositories, worktrees, received attachments,
exports, signing keys, and unrecognized files. The narrower
`muxr daemon uninstall` and `muxr integrations uninstall` remain available for
advanced maintenance.

## Verify

- `muxr doctor` reports healthy relay, host, and pairing state with credentials
  redacted.
- `muxr devices list` shows the paired phone/browser.
- The phone app shows the machine online and renders a live terminal.
