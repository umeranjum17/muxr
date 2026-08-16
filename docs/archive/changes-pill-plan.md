# Archived — changes / attachments pill plan

Shipped. Kept for the original rationale. Current behavior is in
[ARCHITECTURE.md](../ARCHITECTURE.md) and [PLUGINS.md](../PLUGINS.md).

# Changes pill for muxr — plan (agent-agnostic revision)

Status: **Phase 1 + 2 implemented** (2026-08-05/06; run-artifact revision
2026-08-08). Changes pill: contract `session.changes` event, host
`ChangeTracker` (exact full-worktree tree snapshots at run start and
completion, one settled run diff, committed-during-run changes included,
pre-run dirt excluded, per-run artifact preserved and resent on reconnect, no
polling), mobile pill + `/session/[id]/file` diff route (prefers the
host-captured run patch). Attachments: contract `session.attachments` event,
host `AttachmentWatcher` on
`~/.muxr/attachments/pane/<HERDR_PANE_ID>/`, mobile attachments pill
(image grid + swipe viewer). The attachment flow was verified live on the
old deployed stack (decrypted relay log shows attachment events flowing for a
real pane); the **completion-only per-run changes artifact is unit-tested
only so far** — no live deployment has verified it yet (needs a host rebuild
+ restart and a replacement APK). Optional Phase 3 (herdr metadata tokens)
still open.

Waste fixes (2026-08-06, research-backed): attachments carry stable ids
(sha256 of content); `data` inlines only on an id's first emit per host run —
the list stays cumulative-metadata, clients merge by id (kills the O(n²)
re-send). Phone persists metadata only in MMKV (`session-attachments-v2`),
blobs live on the app filesystem keyed by id (web: in-memory). Watcher has a
30s rescan backstop for Linux fs.watch gaps. Verified live: second emit
carried data for the new file only.

Convention note: attachments are **per-pane** (Umer, 2026-08-06): the dump dir
is keyed by HERDR_PANE_ID, not cwd — splits sharing a cwd get separate pills.
Agents learn the convention from the global `muxr-attachments` skill.
(The 2026-08-06 live demo line was the polling-era pill showing its own edit
as it happened; the completion-only model emits nothing until the run settles,
so that live demonstration no longer applies and has not been re-run on the
new model.)

Verified: 12/12 contract events through live relay probe (polling-era), detector
tests (reset, staged, unstaged, untracked, committed-during-run,
commit-then-cancel, same-count dirt edit, non-git, restart-settled clear,
reconnect resend, stale runs, concurrent settles, concurrent worktrees),
live repo checks, production web export build.
Fake host drift found+fixed during testing (readFile returned base64; contract
is utf8). The polling-era live browser pass (real pi agent edit → pill
appeared mid-run → sheet → split diff) verified the OLD live-updating pill;
no live deployment has verified the new completion-only behavior yet.

## Principles

- The app knows two things only: **git repos** and **one directory convention**.
- Nothing per-agent anywhere: no tailers, no mappers, no hooks, no installs.
- Pi, a shell script, or the user with `cp` participates
  by doing generic things: writing files in a repo, dropping files in a dir.

## Feature 1 — Changes pill (git layer, covers every agent)

Host-side per-session detector in `apps/host/src/herdr/herdrSessionSource.ts`:

- **Trigger**: `pane.agent_status_changed` → transition into `working` starts a
  run (capture baseline + HEAD, emit an empty reset); `idle`/`done`/`blocked`
  settles it (one final run diff with captured patches). While a run is active
  a 30s live tick re-diffs the worktree against the baseline and emits the
  cumulative-so-far file list without patches (the viewer falls back to live
  git mid-run), so long runs update the pill before they settle.
- **Collect**: `git status --porcelain=v2 -z` + `git diff --numstat` (staged,
  unstaged, untracked) in the pane's live cwd — the host already resolves
  `agent.foreground_cwd ?? pane.foreground_cwd ?? …` in `infoFor()`.
- **Baseline**: repo state + HEAD when the run starts, pinned to the repo
  resolved at that moment (concurrent sessions/worktrees stay isolated). The
  settled diff covers the working-tree delta since the baseline **plus commits
  made during the run**, so pre-run dirt never leaks and a run that committed
  and left a clean tree still reports its full delta. Herdr worktree sessions
  get clean attribution free.
- **Emit**: new contract event `session.changes` carrying the **cumulative**
  file set `{path, name, added, removed, status}` plus each file's run patch
  (committed part + uncommitted part, size-bounded) — idempotent replace,
  immune to relay replay gaps, no client dedupe. The settled artifact is
  preserved host-side and resent verbatim to reconnecting clients.
- **Diff body**: lazy via the existing `session.shell` request
  (`git diff -- <path>`) — no new request types needed;
  muxr mobile already ships `gitStatusFiles.ts` + `git-parsers/`.

Blind outside git repos (degrades silently) and blind to reads — accepted;
reads are the attachments feature below, solved generically.

## Feature 2 — Attachments (one common dump directory)

Convention: `~/.muxr/attachments/<cwd-slug>/`

- `<cwd-slug>` = `$PWD` with leading `/` stripped, remaining `/` → `-`
  (`/home/umer/muxr` → `home-umer-muxr`). One sed line, same
  transform host-side. Deterministic attribution: a file lands in a slug dir →
  it belongs to the session(s) whose cwd matches.
- **Host watcher**: `fs.watch` recursive on `~/.muxr/attachments/` —
  our own small dir, so no inotify-budget problems (this is the one place
  fs-watch is the right tool; it is never used on repos).
- **Emit**: new contract event `session.attachments` — cumulative list
  `{name, relPath, mimeType, size, data?}`; images ≤1 MiB inlined base64
  , bigger files listed name+size only.
- **Who writes there**: anything. `agent_browser` screenshots/snapshots,
  generated images, exported CSVs, recordings — the agent copies final
  user-facing artifacts in. Mobile renders images inline, lists the rest.
- **Cleanup**: keep latest 50 per slug; drop the slug dir when its pane closes.

### Teaching agents the convention (one global skill, zero app coupling)

A single global pi skill + one matching line for other agents' global configs.
The app never references any agent; agents reference the directory.

Skill (`global` scope, ~15 lines of procedure):

> When you produce a user-facing artifact (screenshot, snapshot, image,
> recording, export), copy it to
> `~/.muxr/attachments/$(echo "$PWD" | sed 's|^/||; s|/|-|g')/`
> (mkdir -p first). One line, then continue. Don't dump intermediate junk —
> final artifacts only.

`agent_browser` needs no changes — it already saves artifacts wherever told;
the skill just makes the attachments dir the default place.

## Contract changes (`packages/contract`)

- `sessionState.ts`: `SessionChangeFile {path, name, added, removed, status}`,
  `SessionAttachment {name, relPath, mimeType, size, data?}`.
- `sessionEvent.ts`: add `session.changes` + `session.attachments` to
  `SessionEventBody` / `SESSION_EVENT_TYPES`.
- No new request types for MVP (`session.shell` + `session.readFile` cover the
  diff viewer and file body).

## Host changes

- `herdrSessionSource.ts`: `ChangeDetector` (git collector on status
  transitions) publishing cumulative `session.changes`.
- New `apps/host/src/herdr/attachmentWatcher.ts` (~120 lines): fs.watch +
  mime sniff + inline-small-images → `session.attachments`.
- `host.ts` / `relayLink.ts`: untouched — event forwarding is agnostic.

## Mobile changes (mostly cloned already, dormant)

Already in `apps/mobile/sources`, unused: `sessionFileChanges` slice +
`absorbFileEdits` + MMKV persistence, `ChangesFileRows.tsx`,
`diff/{DiffView,PierreDiffView,calculateDiff}`, git parsers.

- `sync/sync.ts`: handle the two events → replace per-session slices
  (cumulative = trivial).
- The pill components (changes + attachments) live in apps/mobile/sources/components
  (the attachments pill already does image grids + swipe paging — feed it the
  new slice instead of transcript messages).
- Mount the pill row in `TerminalScreen.tsx` above the prompt input.
- Port `app/(app)/session/[id]/file.tsx` (works against `session.shell`
  git-diff + `session.readFile` — both exist in the contract).

## Phasing

1. **Phase 1 — changes pill**: contract + git detector + pill + diff route.
   ~400 lines host, ~150 net-new mobile.
2. **Phase 2 — attachments**: watcher + attachments event + pill port +
   the global skill. ~120 host, ~150 mobile, one skill file.
3. **Phase 3 (optional)**: `pane.report_metadata` tokens
   (`{changes: "3 files +42/−5"}`) so counts show in herdr's own desktop UI —
   one socket call per update, still fully generic.

## Rejected (and why)

- **Per-agent transcript tailers / hooks / `herdr integration install`** —
  couples the app to agent internals. Killed by directive.
- **Terminal output parsing** — every agent renders differently; no
  per-file reliability.
- **fs-watch on repos** — inotify limits, no counts/diffs; git is the truth.
- **herdr plugins** — argv callbacks, can't see tool calls; adds install
  surface for no capability gain.

## Risks / edges

- Attribution in shared checkouts: pill means "changes since this run
  started" — pre-run dirt excluded. Worktrees = exact; each session pins the
  repo it was resolved to at run start, so concurrent teams never cross-wire.
- Agent commits mid-turn: the settled diff is the exact diff between the
  run-start and run-end full-worktree snapshots (temp alternate index), so a
  committed-and-clean settle still reports its full delta and a change made
  and reverted during the run nets to zero; the host preserves and re-sends
  the artifact. (The old polling-era "live demo line two — the poll caught
  this within 4 seconds" no longer applies; nothing is emitted until the run
  settles.)
- Attachments slug mismatch = file unattributed (worst case: invisible, not
  wrong). Skill + host share one documented transform.
- Relay has no replay: the host resends each session's preserved artifact (or
  the mid-run reset) on reconnect; client also keeps MMKV persistence.
