# Keep one Home row through an agent relaunch

Home assigns an agent to exactly one of Live, Needs you, Ready · unseen or Failed. A section change must persist for 1.5 seconds; a replacement route in the same pane, or the same named agent in its workspace, keeps its Home identity despite a task-title change. A Live preview retains its last nonempty frame while the replacement is empty or unavailable.

## Sub-features

- Working → blocked → working within 1.5 seconds never moves the row.
- A sustained blocked state moves to Needs you once, not a second Live card. Relaunch while that row is in Needs you: its first returned Live frame must already show the held picture, before the replacement produces output.
- An unopened done outcome moves to Ready once; a later working/blocked state and a replacement generation suppress the old done notice.
- Closing the old pane and opening its replacement holds one row through the short gap. The current route is always the navigation target; names only reconcile display identity.
- A genuinely empty, never-populated preview still shows the existing empty placeholder. Other terminal surfaces retain their empty-frame policy.

## How to get to it (user POV)

Pair a lab computer, leave Home open while its agent works, then relaunch that agent with its same name and a changed task title. Watch the card, then leave it blocked and finish its turn without opening it. There is never a second row for the old generation.

## Driving it with the private stack

Preconditions: built host/relay, candidate native release APK and web export; a real named Herdr lab through the fleet's guarded helper. Use `scripts/diagnostics/application/linkHerdrLab.mjs` with `HERDR_LAB_HELPER`, `HERDR_LAB_SESSION` and `HERDR_LAB_PREPROVISIONED=1`; its wrapper scopes every Herdr call. Provision and teardown only through the helper, with teardown installed before provisioning. Do not use the fake herd as relaunch proof.

1. Start an actual idle `pi` in a lab pane, give it a published name and task title, and pair native and standalone app-mode PWA to this lab host. Use only task-owned app/profile state. A physical phone requires the device lock for the whole journey and a unique dev application ID, never the owner's installed package (see `perf/README.md`, Side-by-side physical phone probe).
2. Read the live tree and lifecycle through the paired link. Exercise short working/blocked flips with the pane's public lifecycle-report command, then a sustained blocked → working transition. Check the single row before and after the 1.5-second dwell, rather than treating the immediate badge count as the debounced row count.
3. While recording the native screen, close the old pane, create its replacement in the same workspace, and start the actual agent with the same name and changed title. Record both route/pane identities from the paired link; capture the pane gap and first replacement frame. Do not substitute a fabricated lifecycle event or a second agent running alongside the old one.
4. Capture before/during/after at 390 px, light and dark, plus the Visual check's native and standalone PWA matrix and desktop 1280/1440 light/dark. Read each shot and the recording: one row, no stale Ready/Needs duplication, last terminal frame held until nonempty output replaces it. Retain the tree/lifecycle timeline beside the media.
5. Seal the capture with done-done against the candidate HEAD and run the judge on the specific single-row/preview claim. A passing selector flow is useful regression coverage, not native relaunch proof.

## Gotchas

- Task titles change freely and are never identity keys. Agent names reconcile display only within the same workspace; navigation still uses the current Agent Route.
- Ready is an unseen outcome, not an independent copy of every done event. Current tree state supersedes historical notices for a present agent.
- The 1.5-second grace is screen-local presentation state, not a new host lifecycle ledger. The Spaces/badge count remains immediate.
- The agent pager keeps its existing shared order; only the Home section membership is debounced.
- Needs you unmounts the Live preview. A stable React key alone cannot retain that component's text: Home's nonempty snapshot must outlive the card and its pane route, without surviving a computer switch.
