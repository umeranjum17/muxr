# Move an agent to another computer

From an agent's Pane actions, **Move to another computer** carries the same conversation to another paired
computer and resumes it in a pane there; the person lands in it. A kind that cannot move keeps **Continue on
another computer** (the handoff note, `continue-on-computer.md`) in the same place, and a move that cannot
happen offers it as **Continue instead**.

## How it is built

- One shared core, `moveToComputer()` (`apps/mobile/sources/herd/application/moveToComputer.ts`): check the
  destination, pack on the source, carry in bounded chunks, import and resume there. It never touches the source
  agent; the sheet retires it only on the person's say-so (the existing stop and its confirm).
- The phone is the courier. Host requests (`move.*`, `packages/contract/.../requests.ts`): `move.offer` (source:
  movable or the plain note `Continue`), `move.ready` (destination: installed, signed in on its own, its home),
  `move.export` / `move.read` (source: the kit's portable bundle, 192 KiB chunks), `move.stage` / `move.import`
  (destination: SHA-256 checked, then `importConversation` into this computer's own sign-in folder and a resumed
  agent in a pane), `move.release`. Bundles live under `<muxr home>/moves/`, are swept after an hour and are
  never put in one frame. Peers cannot call them (they are not in any peer capability).
- A kind plugs in with one adapter, `apps/host/src/move/domain/adapters.ts` (the provider whose sign-in folder
  holds its conversations). Claude is wired; Codex and Pi are follow-ups. A kind with no adapter answers `Continue`.
- A computer the app reaches only by switching to it (SSH, a loopback relay) is moved to buffered: the whole
  bundle is read first, then the app switches and stages it; the source then stays open and the sheet says so.

## What it cannot carry, and why that is acceptable

- A running process or a live shell (a dev server, a half-run command): a process is not a conversation; the
  destination starts a fresh agent that resumes the conversation, and the sheet lists this under "What stays behind".
- Sign-ins and keys: credentials never move. The destination resumes on its own sign-in, and a destination that is
  not signed in refuses (`move-not-ready`) before anything is sent.
- Files outside the conversation (the working tree): the agent resumes in the same folder when it exists there, else
  the destination's home, and says so.
- Conversations past 64 MiB: refused (`move-too-large`) with Continue offered.

## Failure states (both computers stay usable; the source conversation is never touched)

- Cannot start (destination not signed in or not installed; kind cannot move; agent busy): nothing is sent.
- Fails midway (link drops, a chunk is lost, digest mismatch): the destination's staged bundle is removed, nothing
  is imported, the source keeps running, Try again / Continue instead.
- Moved but would not resume (`move-resume-failed`): the conversation is on the destination (kit import done), the
  agent did not start, the source is untouched; Open the destination / Close.

## Export of a running agent

The source exports through the kit with the explicit sign-in folder the agent's pane runs on (`exportConversation`
with `accountFolder`, `@byokit/herdr` 0.18), so an agent that was already running, or survived a host restart,
moves too. A managed account whose `projects` is a link to the computer's own store exports and imports through that store.

## Driving it

`moveLab.mjs` brings up Desk and Laptop (real relay, host, guarded Herdr lab session, stand-in Claude that keeps a
real Claude transcript). `moveToComputerPwaLab.mjs` (journey `move-to-computer`) pairs the installed PWA with both,
opens the agent on Desk, and records pick, confirm and outcome at 390 and 1280, dark and light; on a success it
reads back through Laptop's own Herdr that the same conversation id and its earlier turn are running there and that
a new turn is answered with the old one remembered.
