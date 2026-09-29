# Self-naming

One provider-agnostic naming system. The agent names its own workspace and pane
through the canonical muxr skill:

```sh
muxr name --workspace 'auth rework' \
  --pane 'Fix login validation --carefully' \
  --provider pi --model gemini-3-flash
```

`muxr name` (`client.mjs`) calls the Herdr CLI directly, so it works wherever
Herdr runs, with or without a muxr host. It uses the current Herdr pane identity
(`HERDR_PANE_ID`) and the Herdr binary from `HERDR_BIN_PATH` or `HERDR_BIN`
(else `herdr` on PATH). Inside a pane Herdr exports that session's socket, so a
named session needs no extra flag. It reads the pane's current workspace from
Herdr before mutating anything.

- `workspace` → `herdr workspace rename` on Herdr's current workspace membership.
- `pane` → `herdr pane rename`: the task line muxr shows under the agent's
  name (a plain shell leads with it).
- `provider`/`model` → Herdr pane metadata tokens (`--source muxr.naming`).
  Herdr metadata is the single canonical source consumed by the host and both
  mobile clients; there is no second JSON naming authority.
- Names pass through verbatim: no re-parsing or stripping. Bounds are enforced
  (512-character strings, no control characters, no leading `-`), by
  rejection, never by mutation.

It prints `{"ok":true,"status":"ok","results":{…}}` on success. A partial or
failed Herdr result exits 1 and names each failed operation with bounded error
text; it is never reported as success. Repeating a request is safe.

`server.mjs` is no longer part of naming. It is the loopback behind
`muxr preview status` (port 8797, `MUXR_NAMING_PORT`; token under
`$MUXR_HOME/naming/token`, `MUXR_NAMING_AUTH_FILE`).

Run the deterministic boundary check:

```sh
node scripts/naming/naming.selfcheck.mjs
```

It drives `muxr name` against a Herdr command fixture (verbatim names, target
binding, rejected input, preflight and partial Herdr failure, a slow sequence)
and the preview loopback over real HTTP (authorization, target binding, restart).

## Fallback naming

`animal-namer` remains enabled only to fill an absent Agent Name when an agent
has not self-named. Do not bundle or install a title-guessing plugin, and do
not overwrite user-owned Herdr registrations.
