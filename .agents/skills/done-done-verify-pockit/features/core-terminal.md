# Terminal on Herdr Core (lab only)

jg-kile slice 7. The host's terminal bridge (`apps/host/src/agent/infrastructure/herdrCoreTerminal.ts`) opens one
framed Herdr Core connection per view and presents the stream the terminal manager already drives. No user can
select it: it runs only with `--herdr-core-lab` plus `MUXR_HERDR_CORE_SOCKET`, which a real muxr home refuses.

## Rules it proves

- The phone opens the agent's terminal and types; a typed line reaches the program (`echo hi` answers `hi`).
- A preview watches only: Home reads the screen with `pane.read` (Core's `terminal.read`), and an `observe` view never resizes the terminal or types.
- Core sends only what the viewer has granted in CREDIT frames; a paused phone holds Core back.
- Scroll position is no longer read from Herdr: the host reports no scrollback offset on Core.

## Run

```sh
yarn build
MUXR_LAB_APK=<x86_64 release apk> MUXR_LAB_AVD_HOME=<scratch avd home> \
  flock -o -w 3600 /tmp/fm-muxr-emulator.lock done-done verify core-terminal --outcome "<claim>"
```

The journey records the terminal's size on the computer (`terminal.get`) before the phone looks, with Home's
preview watching, with the phone's terminal open, and after it leaves. Before and with the preview must match.

## Not built yet

Resize notifications from Core to the phone, and scrollback, history and Latest on Core terminals.
