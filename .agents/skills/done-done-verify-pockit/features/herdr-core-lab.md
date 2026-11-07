# Drive a lab Herdr Core from the proof harness

The proof harness can start a private, pinned Herdr Core beside the fake Herdr TUI and drive
every call the muxr host will make on it once the host reads Herdr Core. This is plan step 2 of
the Herdr Core switch: it proves the harness on the core, not the product. The host still reads
Herdr TUI only and cannot see Core agents until plan step 3. How each Herdr journey moves to
the core, or is retired, is in [herdr-core-ports.md](herdr-core-ports.md).

## Sub-features

- **Pinned release** (`ensureHerdrCore()` in `perf/lib/herdrCoreLab.mjs`).
  - `HERDR_CORE_PIN` names the version and its SHA-256.
  - The cached tarball is checked against the pin and the release's own `manifest.json` on
    every use.
  - The cache is `MUXR_LAB_HC_CACHE`, else `~/.cache/muxr-lab/herdr-core`, never the repo.
- **Private lab core** (`startHerdrCore()`).
  - Each core gets a 3-character owner-only dir `/tmp/k??` and a 2-character `HC_SESSION`.
  - It has its own HOME and XDG runtime/state/config/data/cache dirs, and an allowlisted env:
    no agent logins, no SSH agent, no muxr or Herdr TUI variables.
  - `herdr-core serve` runs as our foreground child. The private `XDG_RUNTIME_DIR` keeps it
    out of the systemd user manager.
  - Startup refuses a socket answered by any PID other than that child's.
  - `stop()` runs `hc server stop` scoped to the session, then signals the child's own PID if
    needed, then removes the dir.
- **Host-shaped client** (`coreClient()`).
  - It speaks JSON-RPC lines, then framed mode after `hello`.
  - It reads attach bytes and returns credit, and it can type and detach.
- **fakeStack opt-in**: `startFakeStack({ herdrCore: true })` returns the core as
  `stack.herdrCore`. Nothing points the host at it yet.
- **Journey `herdr-core-lab`**: `herdrCoreLab.mjs` drives the calls end to end.

## How to get to it (user POV)

No user sees this: it is harness plumbing with no product change. An agent proving the
harness runs `done-done verify herdr-core-lab --outcome "<claim>"` from the repo root.

## Driving it with the private stack

Preconditions:
- `yarn build`, because fakeStack runs the built relay and host.
- Network once, for the first download.
- Linux. The pin covers linux-x86_64 and linux-aarch64.
- No phone or emulator.

```sh
done-done verify herdr-core-lab --outcome "<claim>"
# by hand: node .agents/skills/done-done-verify-pockit/features/herdrCoreLab.mjs <evidenceDir>
```

| Step | Calls (the ones the host will make) | Capture |
|---|---|---|
| 1 | pinned release, file and manifest digest | `01-pin.txt` |
| 2 | fakeStack with `herdrCore`; host online; `server.status` PID is our child | `02-stack.txt` |
| 3-6 | `events.subscribe`; `terminal.run {argv, cwd, name, labels: herdr.space/herdr.tab/muxr.kind/muxr.resume, keep}`; `terminal.send`; `terminal.wait` → done, turn 1; `terminal.label` moves the tab | `03-start-prompt.txt` |
| 7 | `hello {framed}` (generation 1); `terminal.attach` at 48x20; type `echo hi` over DATA and see the answer; `terminal.read`; the agent saw `HC_TERMINAL_ID` equal to its address | `04-live-view.txt` |
| 8 | `doc.get herdr-app` reads version 0 on a fresh core; `doc.set` writes version 1; a stale write is refused with `conflict` | `05-documents.txt` |
| 9 | `terminal.kill`, `terminal.rm`; the one subscription saw created, status, turn, labels, doc, finished, removed | `06-events.txt` |
| 10 | core stopped by its scoped stop, PID gone, dir removed; relay and host PIDs gone | `07-teardown.txt`, `gate.log` |

Pass: `gate.log` ends `PASS:` and every check line before it starts `ok`. `steps.json`
states the claim. If the opt-in is broken (`stack.herdrCore` missing), the journey fails at
step 2.

## Gotchas

- The direct Core lifecycle here is a time-boxed exception. When the fleet's Herdr lab helper
  learns Herdr Core (plan step 1), that helper becomes the only lifecycle path.
- Nothing here calls `herdr`, touches the default Herdr session, the plugin registry,
  `muxr.service` or the relay on 8792, or reads `~/.muxr`. Herdr Core is a separate binary
  and socket from Herdr TUI.
- Keep the lab dir at 3 characters under /tmp. The holder sockets sit beside the core socket
  with an 8-character id, and the path limit is 107 bytes.
- `hc(args)` in the lab appends `--json` last. Use it only for verbs with no program argv;
  start programs with `terminal.run`.
- Not proved here:
  - the host or the phone on Herdr Core (step 3);
  - other machines (`hc machine add`, step 4);
  - the Herdr app's own `herdr-app` document format (only its empty read).
