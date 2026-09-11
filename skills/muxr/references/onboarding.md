# Onboarding: install, configure, pair, maintain

Everything muxr does runs on the user's own computer: the relay, the agent
host, the browser app it serves, and the pairing between them and a device.
This reference is for an agent driving that computer. Words are fixed:
**computer** (the machine running Herdr and muxr), **host** (the muxr
process on it), **relay** (routes encrypted traffic, cannot read it),
**browser app** (the daily client served from the computer's own HTTPS
origin), **native app** (optional Android/iOS client), **Herdr plugin**
(installs and operates muxr from Herdr), **pairing link** (one-use, two
minutes), **browser access** (Control or View-only for eight hours, or
explicit Personal Control for 30 days), **machine enrollment** (shared-relay
invitation, five minutes).

## Contents

[Install](#install) · [Desired state](#desired-state) · [Inspect, plan, apply, verify](#inspect-plan-apply-verify) ·
[Secret boundary](#secret-boundary) · [Pairing handoff](#pairing-handoff) ·
[Reapply, update, rollback](#reapply-update-rollback) · [Shared relay](#shared-relay) ·
[Diagnose](#diagnose) · [Uninstall](#uninstall)

## Install

Herdr-first (primary). Pin the released ref you were given:

```text
herdr plugin install umeranjum17/muxr/plugins/control --ref <released-ref>
herdr plugin pane open --plugin muxr.control --entrypoint setup
```

The plugin build resolves npm `latest` for `@trymuxr/cli` to one exact
version, installs it as the current user (no sudo), verifies version and
integrity, records them owner-only in `~/.muxr/herdr-plugin.runtime`, and
prints that second command. Every Herdr pane (Setup, Pair, Devices, Doctor,
Service, shared relay, host voice) runs exactly the recorded executable.

Without Herdr (fallback):

```bash
npm install -g --ignore-scripts @trymuxr/cli
muxr
```

Node 22+ is required on the computer. Interactive `muxr setup` is three
interactions on a fresh computer: accept the one recommended browser-capable
route, Review, Apply. No add-on, provider or theme question appears before
Apply; those are configuration (below) or later commands.

## Desired state

`~/.muxr/config.env` is the whole desired state: `KEY=value` lines, no
secrets, safe in dotfiles. `muxr config` prints the effective values and
where each came from; `muxr config --json` is the same for programs;
`muxr config --schema` prints the table below as JSON.

<!-- config-attributes:start -->
_Generated from the configuration schema (version 1) by `scripts/release/application/generateConfigDocs.mjs`; edit the schema, not this table._

| Key | Values | Default | Applies to | Restart | Meaning |
|---|---|---|---|---|---|
| `MUXR_SETUP_ROLE` | `single-machine` · `shared-relay` · `remote-host` | `single-machine` | always | relay and host | What this computer is: the usual relay+host on one machine, an always-on shared relay for other machines, or an agent host enrolled with a shared relay. |
| `MUXR_CONNECTION` | `tailscale` · `tailscale-direct` · `private` · `lan` · `cloudflare` · `external` | unset | single-machine, shared-relay | relay and host | How devices reach the relay. tailscale (Serve, HTTPS), cloudflare (quick tunnel, HTTPS) and external (your own wss:// origin) serve the browser app; tailscale-direct, private and lan are native-only routes. |
| `MUXR_RELAY_PORT` | `1024..65535` | `8792` | single-machine, shared-relay | relay and host | Local relay port. |
| `MUXR_WEB` | `true` · `false` | unset | single-machine | relay | Serve the browser app from this host. Requires a browser-capable connection. A fresh single-machine setup defaults to true; automation must say false explicitly to opt out. |
| `MUXR_ADVERTISE_URL` | `root ws(s)://host[:port]` | unset | connection=external (required), private/lan (optional override) | relay and host | Relay URL devices connect to. Required for external (root wss://host, nothing else in it); derived for the other routes. |
| `MUXR_INTEGRATIONS_SYNC` | `auto` · `on` · `off` | `auto` | single-machine, remote-host | none | Coding-agent lifecycle integrations: auto syncs detected agents, on syncs every supported agent, off leaves them alone. |
| `MUXR_NOTIFY_EMAIL` | `one address` | unset | always | relay | Optional address the relay notifies about attention events. |
| `MUXR_SERVICE_MODE` | `managed` · `foreground` | `managed` | always | relay and host | managed registers systemd/launchd user services that survive logout; foreground runs relay and host only while `muxr up` is running. |
| `MUXR_PAIRING_DEFAULT` | `browser` · `browser-view` · `browser-personal` · `native` · `none` | `browser` | single-machine, remote-host | none | Which grant `muxr pair` and the Herdr Pair pane offer first: browser Control (8 hours), View-only (8 hours), personal Control (30 days), the native QR, or nothing. |
| `MUXR_BUNDLED_PLUGINS` | `<name>=on|off[,...]` | none | single-machine, remote-host | none | Enable or disable bundled muxr plugins by short name (for example code=on,status=off). Unlisted plugins keep their packaged default (enabled). |
| `MUXR_EXTRA_PLUGINS` | `owner/repo[/subdir]@<sha>[,...] | npm:<name>@<version>` | none | single-machine, remote-host | none | Add-on muxr plugins pinned to an exact GitHub commit or exact npm version. Tags, branches and latest are refused so a reapply installs the same bytes. |
| `MUXR_VOICE_PROVIDER` | `installed host voice provider id` | unset | single-machine, remote-host | none | Realtime voice provider selected on this host (see `muxr voice status`). Unset leaves the host choice unchanged. Credentials are never configuration. |

Rules across keys:

- MUXR_CONNECTION=external needs MUXR_ADVERTISE_URL (root wss://host).
- MUXR_WEB=true needs a browser-capable MUXR_CONNECTION (tailscale, cloudflare, external).
- MUXR_SETUP_ROLE=remote-host takes no MUXR_CONNECTION; the shared relay decides.

Not configuration (never in this file, never in a receipt): provider API keys and OAuth logins; the relay owner mint secret; device keys; pairing codes; enrollment strings; one-use invitations.

Precedence, everywhere: `flag` > `env` > `config` > `probed` > `default`. Exit codes for `muxr setup --apply-config`: `0` verified, no unresolved failure; `1` invalid configuration or unavailable prerequisite; `2` dry run: valid plan with changes to apply.
<!-- config-attributes:end -->

Minimal browser-first single machine (Tailscale Serve provides the HTTPS
origin; the browser app is on by default for a browser-capable route):

```text
MUXR_CONNECTION=tailscale
```

Explicit native-only LAN, no browser app, foreground service:

```text
MUXR_CONNECTION=lan
MUXR_WEB=false
MUXR_SERVICE_MODE=foreground
```

Your own HTTPS origin, one pinned add-on, one bundled plugin off, a chosen
voice provider:

```text
MUXR_CONNECTION=external
MUXR_ADVERTISE_URL=wss://muxr.example.net
MUXR_EXTRA_PLUGINS=owner/repo/plugins/thing@0123456789abcdef0123456789abcdef01234567
MUXR_BUNDLED_PLUGINS=status=off
MUXR_VOICE_PROVIDER=xai
```

## Inspect, plan, apply, verify

```bash
muxr setup --inspect                         # read-only: Herdr, agents, routes; changes nothing
muxr setup --apply-config --dry-run --json   # the plan: every key, current vs desired, steps; exit 2 when it has changes
muxr setup --apply-config --json             # apply exactly that plan, then verify; exit 0 only when healthy
muxr doctor --json                           # health rows plus the exact runtime identity (CLI, plugin runtime, plugins, web export)
```

The dry-run plan is byte-identical to what the interactive Review screen
shows for the same config. Apply performs only the listed steps, in order,
and stops at the first failure without printing "complete"; the JSON
receipt names the failed step. A second apply of the same config is a no-op:
nothing restarts, no plugin reinstalls, no grant is minted or revoked.
`muxr self-host --apply-config` is the same plan (kept for existing
automation). Text output for humans, `--json` for programs; secrets appear
in neither.

## Secret boundary

These are actions or credentials, never configuration, and never appear in
`config.env`, `muxr config --json`, plans or receipts: provider API keys and
OAuth logins (`muxr voice key set` reads them hidden or from stdin), the
relay owner mint secret and device keys (machine-written under `~/.muxr`,
owner-only), pairing codes and links, enrollment strings, one-use
invitations. Validation errors name the key, its source and the rule — never
the submitted value — so a mistyped URL with a token in it is not echoed.

## Pairing handoff

Apply never pairs. Pair explicitly, once the plan is verified:

```bash
muxr pair --browser            # Control grant, eight hours: prints one two-minute HTTPS link (or QR)
muxr pair --browser-view       # View-only, eight hours
muxr pair --browser-personal   # Control, 30 days, for a browser only you use
muxr pair                      # native app: one-use QR / short string, two minutes
muxr devices list
muxr devices revoke <number|name>
```

`MUXR_PAIRING_DEFAULT` only chooses which of these the Herdr Pair pane and
the menu offer first. Open the link in the browser you want to pair; the
browser app is served from the computer's own origin and stores its
credential there, so the pairing must happen in that browser (Safari may
pair in the current tab; installing the app later needs a fresh grant in the
installed app's separate storage). Revocation closes that device's sockets
immediately and invalidates its tickets.

## Reapply, update, rollback

```bash
muxr setup --apply-config --dry-run   # exit 0: nothing to do; exit 2: changes listed
muxr update --check                   # what the channel offers, nothing changed
muxr update --yes                     # install the exact target, move the Herdr plugin runtime record, restart services
muxr update --to <version> --allow-downgrade --yes   # rollback through the same owner
muxr doctor --json                    # confirm the runtime identity you expect
```

`muxr update` is the only updater. After a successful install it verifies
the executable reports the target and rewrites `~/.muxr/herdr-plugin.runtime`
atomically; a failed install leaves the previous record and runtime in
place. Rollback is the same transition downward. Herdr panes keep operating
across both because they execute whatever the record names.

## Shared relay

`MUXR_SETUP_ROLE=shared-relay` on the always-on server; agent computers use
`MUXR_SETUP_ROLE=remote-host` and enroll once with an enrollment string:

```bash
muxr shared-relay                          # on the server (interactive), or apply-config with the role
muxr machines enroll|list|revoke           # on the server
muxr connect --enrollment <string>         # on each agent computer, once
```

Enrollment strings are single-use and expire after five minutes; they carry
no relay-owner authority. A remote host has no `MUXR_CONNECTION`: the
shared relay decides the route.

## Diagnose

`muxr doctor` names the failing phase, the cause and the next action, and
never prints "complete" while a check fails. `muxr diagnostics` prints
bounded redacted history; `muxr report > muxr-report.md` drafts an issue
locally and never submits it. Do not hand-edit `~/.muxr`.

| Failing check | Safe next action |
|---|---|
| Herdr server or integrations | accept doctor's offered repair or `muxr integrations sync`, then rerun doctor |
| muxr service, relay, peer access | `muxr daemon restart`, then `muxr doctor` |
| plugin runtime record drifted | `muxr update` (moves the record) or reinstall from the exact plugin source with the pinned ref |
| browser app refused on this route | `MUXR_CONNECTION` must be tailscale, cloudflare or external; LAN and private routes are native-only |
| relay port occupied | `ss -ltnp 'sport = :8792'` (Linux) / `lsof -nP -iTCP:8792 -sTCP:LISTEN` (macOS); stop only a process you recognize, or change `MUXR_RELAY_PORT` |
| expired pairing | `muxr pair --browser` (or `muxr pair`) for a fresh one-use link |

## Uninstall

`herdr plugin uninstall muxr.control` removes only the Herdr plugin checkout.
`muxr uninstall --yes` is the bounded operational teardown: services,
runtime records, machine identity, grants, provider keys and managed
integrations go; Herdr, its sessions, repositories, worktrees, received
attachments and unrecognized files stay.
