# Start, prompt and stop an agent on Herdr Core (lab only)

jg-kile slice 6. The host's Herdr Core source (`apps/host/src/agent/infrastructure/herdrCoreSessionSource.ts`)
starts an agent with Core's `terminal.run`, prompts it with `terminal.send` and stops it with `terminal.kill`
then `terminal.rm`. Core keeps no agent concept, so the agent's place is three labels written at start:
`muxr.kind`, `herdr.space` (the folder's name) and `herdr.tab` (the task, else the kind), built by `launchLabels`
in `domain/herdrCoreAgents.ts`. Still lab-only: `--herdr-core-lab` plus `MUXR_HERDR_CORE_SOCKET`; a real muxr
home refuses the flag. The lab maps the Pi kind to a stand-in program (`MUXR_HERDR_CORE_LAB_AGENT`).

## Run

```sh
yarn build
MUXR_LAB_APK=<x86_64 release apk> MUXR_LAB_AVD_HOME=<scratch avd home> \
  flock -o -w 3600 /tmp/fm-muxr-emulator.lock done-done verify core-start-stop --outcome "<claim>"
```

Journey: New agent (Pi, a folder, Start), prompt, Home reads Working then Done, Stop agent. The journey reads
the labels from Core itself.

Break test: remove the `herdr.space` write in `launchLabels`, rebuild; the journey ends with
`DEFECT the agent has no herdr.space`.
