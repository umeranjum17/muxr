# Keep a source-build host off the real muxr home

A host run from a source build (`apps/host/dist/main.js`), or any `--fake`
host, refuses to start unless `MUXR_HOME` is set and is not the owner's real
`~/.muxr` (passwd home). It prints one line naming `MUXR_HOME` and exits 1. The
shipped bundles (installed CLI `host.js`, desktop `host.mjs`) define
`MUXR_PACKAGED=1` at bundle time, so their normal start is unchanged.

## Driving it

Preconditions: `yarn build`. Never start it in a way that could reach
`~/.muxr`, the default Herdr or relay port 8792.

Run the built host with `env -i` and a throwaway `HOME`, `MUXR_MODE=local`,
`MUXR_RELAY_URL=ws://127.0.0.1:1`, a free `MUXR_HOST_HTTP_PORT`, and
`HERDR_BIN` / `HERDR_SOCKET_PATH` naming missing scratch paths; use the real
node binary (`node -p process.execPath`), since a version-manager shim breaks
under a throwaway `HOME`.

- Without `MUXR_HOME`: `muxr host: a source build refuses the default muxr
  home — set MUXR_HOME to a test folder`, exit 1.
- With `MUXR_HOME=<scratch>/muxr-home`: `host -> ws://127.0.0.1:1 (herdr)
  [local]`, keeps running; stop it by its exact PID. State lands only under
  that `MUXR_HOME`.

The owner-default refusal and the packaged start are covered by the flow test
in `apps/host/src/config.test.ts` (passwd home pinned to a nonexistent path);
live runs never name the real home.

## Gotchas

Abort if any host log names `ws://127.0.0.1:8792`. No screenshots apply.
