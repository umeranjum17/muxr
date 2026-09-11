# Configuration

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
