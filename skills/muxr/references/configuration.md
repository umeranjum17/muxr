# Configuration: desired settings and running state

`selfhost.json` version 2 separates editable desired values at the top level from
machine-written `runtime`. The file is under `${MUXR_HOME:-$HOME/.muxr}` and still
contains credentials. Keep it owner-only; the whole file is not safe for dotfiles,
a report or enrolling another computer.

## Inspect before changing anything

```bash
muxr config
muxr config --json
muxr config --schema
muxr config export
```

Text inspection names the public JSON settings. `--json` currently keys its
`values`, `provenance` and `status` objects by the environment aliases in the table.
The file format is version 2; the inspector's `schemaVersion` is still 1. Those
version numbers describe different things.

`applied` compares desired values with saved `runtime.appliedConfig`; it is not a
fresh health check. `pending apply`, `runtime unavailable` and `not configured`
are distinct states. Run `muxr doctor` for the running instance.

`export` prints the stored desired fields and `version`, without runtime or
credentials. It does not export temporary environment overrides, fill in every
omitted default, or replay anything into another installation.

## Settings

This is the only setting inventory. Names, types and aliases follow the installed
schema; `muxr config --schema` is available offline. Optional values can remain unset; inspect the effective value before changing them.

| JSON setting | Type / allowed values | Schema default | Applicability and effect | Environment alias |
|---|---|---|---|---|
| `setupRole` | enum: single-machine · shared-relay · remote-host | `single-machine` | always; Single-machine relay and host, shared relay, or enrolled remote host. A role change is not enrollment. | `MUXR_SETUP_ROLE` |
| `connectionMode` | enum: tailscale · tailscale-direct · private · lan · cloudflare · external | unset | single-machine, shared-relay; Route used by setup; unset needs a detected or explicit route. Only tailscale, external and the legacy cloudflare route can host the browser app. | `MUXR_CONNECTION` |
| `relayPort` | integer: 1024..65535 | `8792` | single-machine, shared-relay; Exact local listener port; no automatic increment. A restart alone does not promise to repair ingress targets. | `MUXR_RELAY_PORT` |
| `bindHost` | enum: auto · 127.0.0.1 · 0.0.0.0 | `auto` | single-machine, shared-relay; auto resolves to loopback for HTTPS ingress and all interfaces for direct/private/LAN routes. Explicit supported addresses remain explicit. | `MUXR_BIND_HOST` |
| `webEnabled` | boolean: true · false | unset | single-machine; Serve the packaged browser app. Fresh browser-capable single-machine setup chooses true; an existing saved choice is retained. | `MUXR_WEB` |
| `relayUrl` | url: root ws(s)://host[:port] | unset | connection=external (required), private/lan (optional override); Explicit root WebSocket URL for external/private/LAN; derived routes keep their observed URL in runtime. External requires wss. | `MUXR_ADVERTISE_URL` |
| `integrationsSync` | enum: auto · on · off | `auto` | single-machine, remote-host; auto syncs detected lifecycle integrations; on syncs all supported integrations; off leaves them alone. Requires the apply/setup operation. | `MUXR_INTEGRATIONS_SYNC` |
| `notifyEmail` | email: one address | unset | always; Optional recipient. The relay also needs a configured email backend and its credentials; an address alone does not enable delivery. | `MUXR_NOTIFY_EMAIL` |
| `serviceMode` | enum: managed · foreground | `managed` | always; managed uses the OS user service; foreground needs a running muxr up process. A state directory is not a service namespace. | `MUXR_SERVICE_MODE` |
| `pairingDefault` | enum: browser · browser-view · browser-personal · native · none | `browser` | single-machine, remote-host; Chooses the offered pairing action. It does not create, extend, change or revoke an existing grant. | `MUXR_PAIRING_DEFAULT` |
| `bundledPlugins` | map: object: short-name → boolean | `{}` | single-machine, remote-host; JSON object of bundled short names to booleans. Unlisted names keep packaged defaults. Apply/setup performs plugin changes. | `MUXR_BUNDLED_PLUGINS` |
| `extraPlugins` | list: array of pinned source objects | `[]` | single-machine, remote-host; JSON array of pinned source objects: GitHub kind/source/ref or npm kind/name/version. Apply/setup installs them; a raw restart does not. | `MUXR_EXTRA_PLUGINS` |
| `voiceProvider` | string: installed host voice provider id | unset | single-machine, remote-host; Selected host voice provider. Unset leaves the choice alone. Selection is separate from the provider credential. | `MUXR_VOICE_PROVIDER` |

The resolver uses command flags, then environment aliases, then saved desired
values, then probes/defaults. Not every entry point invokes that resolver: a service
restart currently reads the saved web, bind, port and route fields directly.
Do not assume a one-off shell export was saved or installed into the user service.

## Runtime and legacy files

`runtime` holds machine identity and credentials, observed endpoint/bind/web state,
owned ingress and `appliedConfig`. Operational authentication/status reads use that
applied view. Health and ingress observations merge into runtime without replacing
an edited desired value. Never manually copy a runtime block between computers.

A version-1 file can be read through a migrated view; reading it does not itself
complete every lifecycle migration. Legacy `config.env` values still take precedence
before conversion. A `config.env` beside a version-2 file is rejected as a conflict.
Preserve a private backup, reconcile its intended values into the JSON fields, and
retire the legacy file deliberately. Do not leave both as competing sources or
follow the stale error suggestion to use an unavailable `config set` command.

## What a change can do now

`muxr config set` and `muxr config apply` currently return **not in this build yet**.
Those commands do not watch, replay or apply a desired file in this build.

The existing setup planner remains available:

```bash
muxr setup --apply-config --dry-run --json
```

A valid plan with changes exits 2; no change exits 0; an invalid or unavailable plan
exits 1. `muxr setup --apply-config` and `muxr self-host --apply-config` invoke the
existing apply path. Read its first failure and verify the result with `muxr doctor`;
this path is not proof that every v2 startup/ingress/rollback case is implemented.
Never respond to a failure by deleting runtime identity or stopping a foreign listener.

For a known, already configured **version-2 single-machine service**, the startup
path reads top-level `webEnabled`, `bindHost` and `relayPort`. To change only browser
hosting, edit the existing `webEnabled` boolean while preserving all other fields,
then use the service you have verified belongs to this installation:

```bash
muxr restart
muxr doctor
```

Browser hosting still requires a reachable private HTTPS route and packaged web
assets. A missing web bundle currently prints a warning and starts without the
browser app; a successful restart or saved `webEnabled:true` alone is not success.
Check the actual app URL. Remove any stale service-level web-root/origin override
when disabling hosting. Changing the port/route is not a promise that this restart
also reconciles owned ingress. Keep those changes in the reviewed setup/apply path.
Integration, plugin and voice selection actions require apply/setup or their own
commands; restarting the process does not perform them.

## Service ownership and a second instance

`MUXR_HOME` changes the state directory; it does **not** give a managed service a
new identity. In this version, the same OS user still has `muxr.service` on Linux
or `com.muxr.host` on macOS. A different state directory or port alone does not
isolate `muxr restart`, setup, update or uninstall from that registered service.

Before changing services, inspect the registered executable and state directory:

```bash
# Linux
systemctl --user cat muxr.service
# macOS
plutil -p "$HOME/Library/LaunchAgents/com.muxr.host.plist"
```

Only operate on the instance those values identify. A process name, PID or successful
`/health` response alone does not establish ownership. Keep another application's
listener and HTTPS mapping intact. Use another OS account or computer for a second
managed installation, with its own state, available port, private HTTPS route and
LAN discovery name. Do not use internal test bypasses as an isolation mechanism.

Keep the state directory path short. Local Unix sockets append paths such as
`host/peer/broker.sock` or `host/surface/broker.sock`; the **whole socket path**, in bytes, must fit the OS limit.
Aim below 100 bytes to leave room across platforms. A long worktree or attachments
path is a poor state root. Choose a short owner-only directory before initial setup;
changing `MUXR_HOME` later does not relocate credentials or update a registered service.

## Direct relay environment

These are **relay process inputs**, not additional JSON keys. They take effect when
that process starts. The managed launcher supplies its saved port, bind address,
relay data directory and web origin; an unrelated shell export does not update a
registered service. Put deliberate overrides in the environment of the process or
container you actually operate. Inspect the service definition before changing it.

| Variable | Default / allowed value | Meaning and limit |
|---|---|---|
| `MUXR_RELAY_HOST` | `127.0.0.1` for a bare relay | Listener address. Managed setup selects loopback for HTTPS ingress and an accessible bind for direct routes. Docker sets `0.0.0.0`; keep access private. |
| `MUXR_RELAY_DATA_DIR` | `~/.muxr/relay` for a bare relay | Identity/authority storage. Managed setup derives it from `MUXR_HOME`; Docker uses `/data`. Changing it does not migrate grants. |
| `MUXR_TRUST_PROXY` | false in a normal self-hosted relay; `1`/`true`/`on` enable it | Trusts the nearest forwarded client IP for rate limiting. Enable only behind a trusted proxy that controls forwarded headers and when clients cannot bypass it. |
| `MUXR_ALLOWED_ORIGINS` | Empty for a bare relay | Comma-separated exact browser origins, such as `https://YOUR-PRIVATE-HOST`. Managed web hosting supplies its origin. This is not a replacement for pairing or private network access. |
| `MUXR_EMAIL_PROVIDER` | Unset; `resend` is implemented | Email backend. There is an interface for alternatives, but SMTP is not implemented by this setting. |
| `MUXR_RESEND_API_KEY` | Unset; secret | Resend credential. Keep it in owner-only secret storage and inject it into the relay's environment; never into a report or command argument. |
| `MUXR_EMAIL_FROM` | Unset | Verified sender address for Resend. Required with a notification recipient. |

For direct relay email, also supply the recipient through `MUXR_NOTIFY_EMAIL`,
the `notifyEmail` alias listed above.

The remaining relay inputs are advanced operating limits or launcher-owned values.
Defaults below assume a normal private relay, without the development API.

| Variable | Default | Meaning and limit |
|---|---|---|
| `MUXR_RELAY_MAX_PAYLOAD_BYTES` | 4194304 (4 MiB) | Maximum WebSocket message size. The development API uses 512 MiB; that is not the production default. |
| `MUXR_RELAY_BUFFER_LIMIT` | 500 | Maximum buffered envelopes for an offline destination. |
| `MUXR_RELAY_BUFFER_TTL_MS` | 86400000 (24h) | Offline-buffer retention in milliseconds. |
| `MUXR_RELAY_REPLAY_LIMIT` | 1000 | Maximum retained replay envelopes per machine. |
| `MUXR_RELAY_REPLAY_TTL_MS` | 3600000 (1h) | Replay retention in milliseconds. |
| `MUXR_RELAY_PUSH_WEBHOOK` | Unset | Optional POST destination for undelivered client notifications. Receives machine/session identifiers and a timestamp; use a receiver you control. No authentication-header setting is implemented. |
| `MUXR_RELAY_PUSH_WEBHOOK_RETRIES` | 2 | Retries after the initial webhook attempt. |
| `MUXR_RELAY_PUSH_WEBHOOK_TIMEOUT_MS` | 3000 | Deadline for each webhook attempt. |
| `MUXR_RELAY_MDNS` | true with local authority | Advertises the relay on the local network; discovery does not authorize pairing. |
| `MUXR_RELAY_MDNS_NAME` | `muxr-<hostname>` | LAN discovery service name. |
| `MUXR_RELAY_MDNS_MACHINE` | Unset in a bare relay | Launcher-supplied non-secret machine locator; not an identity-migration control. |
| `MUXR_RELAY_MDNS_RELAY` | Unset in a bare relay | Launcher-supplied dial URL advertised to discovery clients. |
| `MUXR_RELAY_MDNS_MODE` | Unset in a bare relay | Launcher-supplied connection mode advertised to discovery clients. |
| `MUXR_RELAY_LOCAL_AUTHORITY` | true | Enables file-backed local pairing, ticket and device APIs. Leave enabled for normal self-hosting. |
| `MUXR_RELAY_AUTH` | `strict` | Also accepts `permissive`; weakening authentication is not a connection repair. Loopback development defaults to permissive. |
| `MUXR_RELAY_E2EE` | `on` | `off` is ignored unless the explicit development API is enabled. Keep encrypted transport on. |
| `MUXR_RELAY_DEVELOPMENT_API` | false | Loopback-only synthetic development API; not for a real user installation. |
| `MUXR_RELAY_PUBLIC_EDGE` | false | Embedding switch for public-edge HTTP behavior. Keep false for this private self-host setup. |
| `PORT` | Unused in normal mode | Only a fallback when the public-edge switch is enabled and `MUXR_RELAY_PORT` is absent; do not enable it to configure a private relay. |

Boolean relay inputs accept `1/true/on` and `0/false/off`. Do not rely on invalid
values being rejected: several low-level relay inputs fall back to defaults.
Use setup for ordinary operator changes. Internal development/auth switches,
generated web paths, process IDs, mint secrets and device credentials are not
portable operator settings. Keep strict authentication and E2EE enabled.

Review service definitions locally; they may contain private paths or environment
values. Changing a service environment requires a service-manager reload/restart,
and setup may regenerate a managed definition. Prefer setup-owned controls.

## Voice credentials

Choose and configure the provider on the computer with `muxr voice`; use
`muxr voice status` to check readiness. `muxr voice select xai` selects Grok;
`muxr voice key set` reads the secret hidden, or accepts `--stdin`.
The installed host also knows Gemini, OpenAI Realtime and experimental Codex Voice.
Its current fallback selection is Codex; use status rather than assuming Grok is
selected. Provider keys and existing OAuth credentials are not desired JSON fields.
Realtime speech-to-speech and local/browser dictation remain separate paths.

## Troubleshooting

| Symptom | Cause to check | Command / next action |
|---|---|---|
| `config set/apply: not in this build yet` | The storage/read side exists without those mutators | `muxr config --schema`; use the supported setup planner above, not a guessed flag combination. |
| JSON edit is shown as pending | Desired differs from saved applied state | `muxr config --json`, then `muxr doctor`; use the change path above for that setting. |
| A value differs from the JSON file | A flag or environment alias won precedence | `muxr config` shows provenance; correct that source before reapplying. |
| `config.env` conflicts with version 2 | Two persisted sources remain | Back up privately, reconcile the aliases into desired JSON and retire the legacy file; then `muxr config`. |
| Web enabled but no app | Missing packaged assets, route, or a stale service override | `muxr doctor`; inspect the registered service and actual private app URL. Never treat a healthy relay alone as static-serving proof. |
| Port occupied or a second instance changes the first | Listener/service ownership was not isolated | Inspect the registered executable and state directory as above. Preserve the existing instance and use an unused private route/port. |
| `listen EINVAL` under a long state path | A local socket path exceeds the OS limit | Check the whole path in bytes; use a short state root when setting up a separate installation. |
