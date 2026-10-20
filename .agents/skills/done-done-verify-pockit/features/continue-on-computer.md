# Continue an agent on another computer

From an agent's Pane actions, Continue on another computer asks the source agent for a handoff note, previews it, then starts the same agent kind on the selected paired computer in the mapped home-relative folder and switches there. Once the target accepts the note, the source is retired only if a fresh `session.status` reads `idle` or `done`, through the existing stop, whose widen confirm is a dialog. If the source is busy again, the confirm is declined or the close fails, both agents stay and a notice names the source computer.

## Sub-features

- `picker` reuses the Computers sheet rows: the source is shown as This computer and disabled, offline computers say why, and an online target without the source agent kind is disabled with that reason.
- `note` the source agent writes a note; the phone waits longer than the host's 240-second handoff bound and keeps the source open on every failure.
- `preview` the note is read-only with Start and Cancel; cancelling never starts a target agent.
- `continue` Start creates a new agent of the same kind, maps the source folder relative to each computer's home (or starts at `~` and says so in the note header when the mapped folder is missing), sends the note as its first prompt, then switches and opens it. It never creates a folder.
- `retire` after the prompt is accepted and before the switch: strict `idle|done` read, then `sessionStop` with confirm. Busy-again, a declined confirm or a close error keep the source and show a notice after the switch. A start failure (no note delivered) never reaches this step. Cancel while the note is being written closes the sheet and starts nothing.

## How to get to it (user POV)

Open an agent on Desk, tap `…` in the pane header, and choose Continue on another computer. Pick the online Laptop row, wait for the note, inspect it, then tap Start on Laptop. Cancel from the preview to leave both computers unchanged. Capture Home on Desk before and after (agent gone), the widen confirm, busy-again (make the source work before Start), a start failure (stop the Laptop host by its own PID) and Cancel during the note.

## Driving it with the private stack

Preconditions: build the relay/host assets used by `features/computersLab.mjs`. Run the Desk and Laptop lab instances in isolated UTS namespaces with unique task-owned socket paths; use only their private pairings. Pair both to the task-owned app, start a Pi agent on Desk, and leave Laptop online. The fake host's handoff result is deterministic; this proves phone orchestration, not model-generated note quality.

On a release APK installed on the task-owned emulator, drive Pane actions → Continue, observe the source row and Laptop, then observe Writing a handoff note… and the read-only note preview. Start on Laptop. Verify the app switches to Laptop and opens a Pi session whose first prompt contains the note; verify the original Desk session is gone (its widen confirm dialog, tab then workspace when it is the last pane, is answered in that dialog). Then repeat with the source made busy before Start: both stay and the notice names Desk. Also capture the offline and not-installed disabled-row reasons. Repeat the journey in the installed PWA. Capture the changed screens at 270 dp and 393 dp with font scale 1.3, in light and dark, and record one motion clip of the sheet steps. Inspect every capture before retaining it. Keep all captures in the task's stable evidence directory and name them in the PR.

## Gotchas

- Stand-in agents report lifecycle with `herdr pane report-agent --seq <n>`; seqs must rise, so use `date +%s%N` for both the stand-in and any control command or a late lower seq is ignored.
- In the PWA lab, pair with `window.__MUXR_LAB_PAIR__(link)` (web export built with `EXPO_PUBLIC_MUXR_LAB_PAIR=1`); a reload mid-confirm aborts the flow, so do not reload during a run. At 270 dp tap the Live card, not the Spaces row, to open the agent.
- Keep each lab host in the foreground with its own private `MUXR_HOME`; learn ports from the process that started each relay. Do not touch the owner's service, relay, Herdr session, or pairing data.
- The preview may be long, so its sheet body must scroll to the Start and Cancel controls on the short viewport.
- A target that starts but does not accept the prompt remains visible on that computer; report the cause and leave the source open. Do not retry into a duplicate target agent.
- The first host's home-relative mapped path can be absent on the target. Retry only the start in `~`, never `createCwd`, and say that fallback in the note header.
