# Onboarding: install, configure, pair, maintain

Everything muxr does runs on the user's own computer: the relay, the agent
host, the browser app it serves, and the pairing between them and a device.
This reference is for an agent driving that computer. Words are fixed:
**computer** (the machine running Herdr and muxr), **host** (the muxr
process on it), **relay** (routes encrypted traffic, cannot read it),
**browser app** (the daily client served from the computer's own HTTPS
origin), **native app** (optional Android/iOS client), **Herdr plugin**
(installs and operates muxr from Herdr), **pairing link** (one-use, short-lived),
**browser access** (Control or View-only for a fixed lifetime, or explicit
Personal Control for longer), **machine enrollment** (shared-relay invitation,
one-use). The exact lifetimes are in the release facts below.

## Contents

[Install](#install) · [Desired state](#desired-state) · [Inspect, plan, apply, verify](#inspect-plan-apply-verify) ·
[Secret boundary](#secret-boundary) · [Pairing handoff](#pairing-handoff) ·
[Reapply, update, rollback](#reapply-update-rollback) · [Shared relay](#shared-relay) ·
[Diagnose](#diagnose) · [Uninstall](#uninstall)

## Install

Herdr-first (primary). The ref is the current release tag:

<!-- herdr-commands:start -->
```text
herdr plugin install umeranjum17/muxr/plugins/control --ref v0.1.28
herdr plugin pane open --plugin muxr.control --entrypoint setup
```
<!-- herdr-commands:end -->

The plugin build resolves npm `latest` for `@trymuxr/cli` to one exact
version, installs it as the current user (no sudo), verifies version and
integrity, records them owner-only in `~/.muxr/herdr-plugin.runtime`, and
prints that second command. Every Herdr pane (Setup, Pair, Devices, Doctor,
Service, shared relay, host voice) runs exactly the recorded executable.

Without Herdr (fallback):

<!-- npm-commands:start -->
```bash
npm install -g --ignore-scripts @trymuxr/cli@latest
muxr
```
<!-- npm-commands:end -->

Node 22+ is required on the computer. Interactive `muxr setup` is three
interactions on a fresh computer: accept the one recommended browser-capable
route, Review, Apply. No add-on, provider or theme question appears before
Apply; those are configuration (below) or later commands.

## Desired state

`~/.muxr/config.env` is the whole desired state: `KEY=value` lines, no
secrets, safe in dotfiles. `muxr config` prints the effective values and
where each came from; `muxr config --json` is the same for programs;
`muxr config --schema` prints the installed schema as JSON.

Use the [configuration reference](../../../docs/user/configuration.md#attributes)
for the setting inventory. `muxr config --schema` reports the installed schema;
keep its defaults and effects tied to the installed release.

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
muxr pair --browser            # Control grant: prints one one-use HTTPS link (or QR)
muxr pair --browser-view       # View-only
muxr pair --browser-personal   # Control for a browser only you use, longer lifetime
muxr pair --native             # native app: one-use QR / short string
muxr devices list
```

```
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
muxr doctor --json                    # confirm the runtime identity you expect
```

Rollback goes through the same owner:

```
muxr update --to <version> --allow-downgrade --yes
```

`muxr update` is the only updater. After a successful install it verifies
the executable reports the target and rewrites `~/.muxr/herdr-plugin.runtime`
atomically; a failed install leaves the previous record and runtime in
place. Rollback is the same transition downward. Herdr panes keep operating
across both because they execute whatever the record names.

## Shared relay

`MUXR_SETUP_ROLE=shared-relay` on the always-on server; agent computers use
`MUXR_SETUP_ROLE=remote-host` and enroll once with an enrollment string:

```
muxr shared-relay                          # on the server (interactive), or apply-config with the role
muxr machines enroll|list|revoke           # on the server
muxr connect --enrollment <string>         # on each agent computer, once
```

Enrollment strings are single-use and short-lived; they carry
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
| muxr service, relay, peer access | check `muxr daemon status` and the [registered service ownership](../../../docs/user/configuration.md#service-ownership-and-a-second-instance); only restart that failed instance with `muxr restart`, then `muxr doctor` |
| plugin runtime record drifted | `muxr update` (moves the record) or reinstall from the exact plugin source with the pinned ref |
| browser app refused on this route | `MUXR_CONNECTION` must be tailscale, cloudflare or external; LAN and private routes are native-only |
| relay port occupied | use the port shown by `muxr config`; for 8792: `ss -ltnp 'sport = :8792'` (Linux) / `lsof -nP -iTCP:8792 -sTCP:LISTEN` (macOS). Leave a foreign listener running; choose an unused port through the supported configuration path |
| expired pairing | `muxr pair --browser` (or `muxr pair`) for a fresh one-use link |

For a second instance or `listen EINVAL` under a long state path, read
[service ownership and socket paths](../../../docs/user/configuration.md#service-ownership-and-a-second-instance).
A different `MUXR_HOME` does not isolate a registered service.

## Uninstall

`herdr plugin uninstall muxr.control` removes only the Herdr plugin checkout.
`muxr uninstall --yes` is the bounded operational teardown: services,
runtime records, machine identity, grants, provider keys and managed
integrations go; Herdr, its sessions, repositories, worktrees, received
attachments and unrecognized files stay.
