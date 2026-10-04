# idb companion (vendored)

`idb-companion.macos-arm64.tar.gz` is the macOS arm64 build of
[facebook/idb](https://github.com/facebook/idb) at tag `v1.6.5`, downloaded
unchanged from the official release asset
`https://github.com/facebook/idb/releases/download/v1.6.5/idb-companion.macos-arm64.tar.gz`.

On a macOS host the iOS-simulator preview unpacks it once into
`~/Library/Caches/muxr/idb-1.6.5-<hash>/` and runs two of its programs against
a simulator an agent pane claimed with `muxr preview claim`:

- `sim-video stream` carries the simulator's framebuffer as Annex-B H.264 (and
  takes `{"method":"force_keyframe"}` on stdin).
- `idb_companion` holds one long-lived HID stream for touch and the Home
  button. It needs the archive's Swift bundles, which is why the whole
  archive ships rather than `sim-video` alone.

Nothing here runs on Linux.

- Version pin: v1.6.5. The HID protobuf fields the host encodes by hand
  (`iosSimulators.ts`) are from this version's `idb.proto`.
- Integrity: `idb-companion.macos-arm64.tar.gz.sha256` (SHA-256 over the
  archive). The host verifies it before unpacking; a mismatch is a refused
  preview, never a fallback.
- License: MIT (Meta Platforms). See `NOTICE` (idb section) and
  `docs/license-inventory.md`.
