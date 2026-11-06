# Triage a broken setup with one command

A stuck user runs `muxr triage` and gets one line per check: what is wrong and
the exact next action. `muxr triage --fix` applies only local, reversible
repairs; everything else stays a printed command.

## Sub-features

- `report` every check prints, nothing changes, nothing asks.
- `fix` a stale `selfhost-rotation.lock` or `relay/relay.pid`, a missing state
  folder, and a `selfhost.json` that is open or unreadable are repaired.
- `report-only` a taken relay port, a CLI older than the host, missing Herdr, an
  unwritable state folder and a stopped host service stay printed; `--fix`
  changes nothing.
- `fail-soft` a probe that throws costs its own section and the rest still print.

## Driving it

```sh
done-done run triage
```

`features/triageLab.mjs` runs the real CLI against broken private homes. PATH
holds only stand-ins, so no real service manager or Herdr can be reached; no
Herdr lab is needed. It writes `fixable.txt`, `missing-folder.txt`,
`report-only.txt`, `fail-soft.txt`, `gate.log` and `steps.json`.

`--fix` must never start, stop or restart a service, signal a process, or use
sudo. A repair joins it only when it is local and reversible; the `safe` flag on
a check's repair in `scripts/setup/infrastructure/localState.mjs` is what admits it.
