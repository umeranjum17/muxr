# Self-naming endpoint

One provider-agnostic naming system. The agent names its own workspace and pane
through the canonical muxr skill:

```sh
muxr name --workspace 'auth rework' \
  --pane 'Fix login validation --carefully' \
  --provider pi --model gemini-3-flash
```

`muxr name` uses the current Herdr pane identity (`HERDR_PANE_ID`) and the
muxr-owned local authorization file. The HTTP facade stays loopback-only,
requires the `muxr://agent` origin, binds the request to that pane, and reads
the pane's current workspace from Herdr before mutating anything. Raw callers
without the authorization capability are rejected.

- `workspace` → `herdr workspace rename` on Herdr's current workspace membership.
- `pane` → `herdr pane rename`: the task line muxr shows under the agent's
  name (a plain shell leads with it).
- `provider`/`model` → Herdr pane metadata tokens (`--source muxr.naming`).
  Herdr metadata is the single canonical source consumed by the host and both
  mobile clients; there is no second JSON naming authority.
- Names pass through verbatim: no re-parsing or stripping. Bounds are enforced
  (64 KiB body, 512-character strings, no control characters), by rejection,
  never by mutation.
- Loopback only (`127.0.0.1`), default port 8797 (`MUXR_NAMING_PORT`).
- `MUXR_NAMING_SESSION` scopes every Herdr call to a named lab session and is
  useful only for isolated validation.
- `MUXR_NAMING_AUTH_FILE` overrides the 0600 token file; the server creates it
  below `$MUXR_HOME/naming/token` by default.

Responses include `status: ok|partial|failed`, per-operation booleans, and
bounded error text. A partial Herdr result is never reported as overall
success. Repeating a request is safe and a server restart reuses the same
muxr-owned token file.

Lifecycle: `muxr up` (`scripts/setup/presentation/up.mjs`) spawns this beside
the relay and host. A naming crash degrades to the fallback namers; it never
takes the relay or host down.

Run the deterministic boundary check:

```sh
node scripts/naming/naming.selfcheck.mjs
```

The check drives the real HTTP server, including authorization, target binding,
verbatim names, malformed/oversized requests, partial Herdr failure, duplicate
requests, and restart. An owned Herdr lab should additionally run it with the
real binary and `MUXR_NAMING_SESSION` set; never point a check at the default
session.

## Fallback naming

`animal-namer` remains enabled only to fill an absent Agent Name when an agent
has not self-named. Do not bundle or install a title-guessing plugin, and do
not overwrite user-owned Herdr registrations.
