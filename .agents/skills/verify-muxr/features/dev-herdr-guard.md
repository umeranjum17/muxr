# Select a safe development Herdr session

The development loop refuses to use the default Herdr session implicitly. Live
suite checks use the same selector; non-live checks still run without Herdr.

## Sub-features

- Unset, blank, default, relative-default and symlink-default paths refuse.
- A lab socket path is admitted without a connection during qualification.
- Only `MUXR_DEV_ALLOW_DEFAULT_HERDR=1` explicitly permits the default.

## How to get to it (user POV)

Use `HERDR_SOCKET_PATH=/path/to/lab/herdr.sock yarn dev`. A person deliberately
using their own default session may set `MUXR_DEV_ALLOW_DEFAULT_HERDR=1`.

## Driving it with the private stack

Preconditions: repo checkout and Node; no running stack or native build needed.
This safety guard must be tested directly, without starting `yarn dev`, `yarn up`
or a Herdr session.

Run `node scripts/diagnostics/application/checkDevHerdrSocket.mjs` and capture
stdout/stderr and exit status. It uses disposable synthetic paths, checks the
refusal and both admission modes, and removes its scratch. To capture the plain
refusal, invoke `devHerdrSocket({})` from
`scripts/development/application/devHerdrSocket.mjs`, catch the error and print
`error.message`. Run `yarn run check:fast` for the registered regression check.

## Gotchas

Admission proves socket selection, not that a lab socket is reachable. Do not
start the development stack to prove rejection: a broken guard could connect
to the real session. No screenshots, themes or motion apply to this CLI guard.
