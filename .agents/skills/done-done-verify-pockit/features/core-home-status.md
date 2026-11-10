# Home on a host that reads Herdr Core (lab only)

jg-kile slice 1. The host has a Herdr Core source (`apps/host/src/agent/infrastructure/herdrCoreSessionSource.ts`)
that lists agents, answers status and the tree from Core's terminal labels, and pushes status changes. No user
can select it: it runs only with `--herdr-core-lab` plus `MUXR_HERDR_CORE_SOCKET`, and a real muxr home refuses
the flag as it refuses `--fake`. The product still runs on Herdr TUI.

## Rules it proves

- An agent is a terminal labelled `muxr.kind`; its space and tab are `herdr.space` and `herdr.tab`.
- Status is the program's own word (OSC 7501). A live terminal that never reported is Starting, never Working or Done.
- The client says `hello`, refuses a newer protocol generation, and after `missed` replaces its state from the fresh snapshot.

## Run

```sh
yarn build
MUXR_LAB_APK=<x86_64 release apk> MUXR_LAB_AVD_HOME=<scratch avd home> \
  flock -o -w 3600 /tmp/fm-muxr-emulator.lock done-done verify core-home-status --outcome "<claim>"
```

`fakeStack({ hostOnHerdrCore: true })` starts the lab core and points the host at it. The stand-in agent works
until a `release` file appears, so each state holds still for its captures (270 dp font 2.0 dark, 393 dp font 1.0 light).

Break test: `CORE_HOME_SILENT=1` runs the same journey with an agent that never reports. It ends with
`DEFECT Home never showed the agent Working`.

## Not built yet

Start, prompt, stop, live terminal, spaces/tabs editing, alerts and ids for other computers are later slices;
those source methods throw "not built on Herdr Core yet". The event stream is not re-opened after Core drops it:
the source reports `connected: false` in the tree.
