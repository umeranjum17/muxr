# Onboarding: install, pair, self-host, maintain

Everything muxr does runs on your own infrastructure: the relay, the agent
host, and the pairing between them and the app.

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
(or `muxr skill`) and explicitly load its self-contained output when you want an
agent to use muxr guidance. Lifecycle integrations only report agent process
status.

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
muxr doctor                    # redacted setup diagnostics
muxr daemon status|logs|start|stop|restart
muxr setup --dry-run           # preview managed-file changes
```

muxr state lives under `~/.muxr` unless `MUXR_HOME` is set.

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
