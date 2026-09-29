# scrcpy-server (vendored)

`scrcpy-server-v4.0` is the device-side mirror server from
[Genymobile/scrcpy](https://github.com/Genymobile/scrcpy) at tag `v4.0`,
downloaded from the official release asset
`https://github.com/Genymobile/scrcpy/releases/download/v4.0/scrcpy-server-v4.0`.

The host pushes it to a task-owned emulator (`adb -s <serial> push`) and runs
it there to carry that emulator's H.264 video and touch/key input for agent
emulator previews. It never runs on the host machine itself.

- Version pin: v4.0. The server's first argument must equal its own version,
  and its video/control wire layout changes between majors, so the host speaks
  exactly this version and refuses anything else.
- Integrity: `scrcpy-server-v4.0.sha256` (SHA-256 over the file). The host
  verifies the hash before every push; a mismatch is a refused mirror, never a
  fallback.
- License: Apache-2.0, same as muxr. See `NOTICE` (Genymobile scrcpy section)
  and `docs/license-inventory.md`.
