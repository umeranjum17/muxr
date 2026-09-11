# Configuration

One file describes the whole setup of a computer: `~/.muxr/config.env`, plain `KEY=value` lines, no secrets, safe to keep in dotfiles. Interactive setup writes it; you or an agent can write it; `muxr setup --apply-config` makes the computer match it.

## Attributes

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
| `MUXR_PAIRING_DEFAULT` | `browser` · `browser-view` · `browser-personal` · `native` · `none` | `browser` | single-machine, remote-host | none | Which grant `muxr pair` and the Herdr Pair pane offer first: browser Control, View-only, personal Control for a browser only you use, the native QR, or nothing. |
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

`muxr config` prints the effective values and where each came from (flag, env, config, probed, default); `muxr config --json` is the same for programs; `muxr config --schema` prints this table as JSON.

## Plan, apply, verify

```bash
muxr setup --apply-config --dry-run          # the plan, nothing changes; exit 2 when there are changes
muxr setup --apply-config --dry-run --json   # the same plan for programs
muxr setup --apply-config                    # apply exactly that plan, then verify; exit 0 only when healthy
muxr doctor --json                           # health rows plus the exact runtime identity
```

The plan lists every attribute with its current and desired value, then the steps it implies. The interactive Review screen prints the same lines. Apply runs the steps in order and stops at the first failure with its cause; it never prints "complete" early and never mints, revokes or emits a pairing link. Applying an unchanged file is a no-op: nothing restarts, no plugin reinstalls.

Two examples. A browser-first single computer on Tailscale (the browser app is on by default on a browser-capable route):

```text
MUXR_CONNECTION=tailscale
```

A native-only computer on the same Wi-Fi, with a bundled plugin off and one pinned add-on:

```text
MUXR_CONNECTION=lan
MUXR_WEB=false
MUXR_BUNDLED_PLUGINS=status=off
MUXR_EXTRA_PLUGINS=owner/repo/plugins/thing@0123456789abcdef0123456789abcdef01234567
```

## Advanced networking

| Route | Needs | Browser app | Native app |
|---|---|---|---|
| `tailscale` | Tailscale connected; Serve free on the relay port | yes (private HTTPS) | yes |
| `cloudflare` | `cloudflared` installed | yes (temporary public HTTPS; use a named tunnel for permanence) | yes |
| `external` | your own `wss://host` origin and `MUXR_ADVERTISE_URL` | yes | yes |
| `tailscale-direct` | Tailscale connected (Serve occupied or disabled) | no | yes |
| `private` | an existing NetBird, WireGuard, ZeroTier or similar interface | no | yes |
| `lan` | the same trusted Wi-Fi | no | yes |

Setup recommends the first browser-capable route it finds. muxr never enables Tailscale Funnel. Set `MUXR_TRUST_PROXY=1` when the relay sits behind cloudflared or nginx so rate limits key on real client addresses.

## Shared relay and remote hosts

One always-on server can relay for several computers. On the server, `MUXR_SETUP_ROLE=shared-relay` with a browser-capable route (or interactive `muxr shared-relay`). Enrollments are created on the server and used once on each computer:

```
muxr machines enroll                       # on the server: prints a one-use enrollment string
muxr connect --enrollment <string>         # on the computer, once; then MUXR_SETUP_ROLE=remote-host
muxr machines list
muxr machines revoke <number|name>         # on the server
```

An enrollment string is single-use, expires after a few minutes and carries no relay-owner authority. Machine keys are created on the computer; the server only returns a credential scoped to that machine. A remote host has no `MUXR_CONNECTION`: the shared relay decides. Changing a relay endpoint requires pairing devices again.

## Plugins

Bundled muxr plugins are enabled by default and toggled with `MUXR_BUNDLED_PLUGINS`. Add-ons are pinned to an exact commit or exact npm version in `MUXR_EXTRA_PLUGINS`; tags and branches are refused so a reapply installs the same bytes. `muxr plugin list|install|update|remove` manage them by hand.

## Voice provider (host-owned)

Which provider answers realtime voice, its account and its key live on the computer only. `MUXR_VOICE_PROVIDER` selects the provider; the key is never configuration:

```bash
muxr voice status
muxr voice select xai
muxr voice key set          # typed hidden; or: muxr voice key set --stdin
muxr voice key clear
```

Clients see **Ready** or **Not configured on this computer**, nothing else.

## Update, rollback, uninstall

```bash
muxr update --check
muxr update --yes
muxr uninstall --yes
```

Rollback names the exact version:

```
muxr update --to <version> --allow-downgrade --yes
```

`muxr update` is the only updater: it installs the exact target, moves the Herdr plugin's runtime record to the verified new executable and restarts the services; a failed install leaves everything as it was. Rollback is the same transition with `--to`. `muxr uninstall` removes services, runtime records, machine identity, grants and provider keys, and keeps Herdr, its sessions, repositories, worktrees and received attachments. `herdr plugin uninstall muxr.control` removes only the Herdr plugin checkout.

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

Next: [Trust](trust.md).
