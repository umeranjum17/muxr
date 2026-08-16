# muxr Control extension

The bundled Herdr command surface installed by `muxr setup`.

- **Host:** runs the bounded muxr control entrypoint from Herdr.
- **Phone (target):** setup/control presentation will move behind muxr's proposed extension host.
- **Authority:** only declared operations are exposed; pairing, E2EE, device revocation, and terminal authority remain kernel-owned.
- **State:** uses muxr state under `~/.muxr`; secrets are never returned as UI data.
- **Removal:** `herdr plugin unlink muxr.control`.
