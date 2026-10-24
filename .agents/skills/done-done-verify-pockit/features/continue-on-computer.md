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

## SSH computer return (slice 0)

- `ssh-return`: each self-hosted computer keeps its own SSH target and confirmed fingerprint beside its secure-store credential. Switching away must retain both; picking it again restores its route before sync reconnects. Existing active-only settings migrate when first read or switched away from.
- `ssh-background`: Computers says **Checked when you pick it** for an inactive SSH computer and allows switching on native. Never background-probe a saved SSH route or a loopback relay, since the native transport owns one tunnel. Continue asks to switch in Computers first; PWA says to open it in the phone app, not Offline.
- `ssh-forget`: forgetting a pairing or all pairings removes its SSH login and saved target; disabling Direct SSH removes its saved target without deleting the login.

After building a release APK with `EXPO_PUBLIC_MUXR_BOAT_API=http://127.0.0.1:<port>/api/v1`, run `cloudSetupLab.mjs` as documented for `cloud-setup`, adding `--switch-route`. It starts a Desk `computersLab.mjs` host in its own UTS namespace after the real namespace sshd cloud setup, pairs Desk, opens a Desk agent's Computers sheet, verifies the cloud row says **Checked when you pick it**, switches back to the cloud, then force-stops and reopens muxr. Read Connection settings without editing before Desk and after returning: capture the filled SSH target and **Saved private key on this device** fingerprint, and require the same visible values. `retained-ssh-route.png` labels these unchanged full frames. Then force-stop, assert the old app process is gone, and capture launcher → app start → connected in one continuous recording, with a new process id and no SSH input. `cold-launch-sequence.png` labels those full frames; keep the raw PNGs and video. Require both sequences and the saved-route PASS in `journey.log`; the return must connect without re-entering SSH credentials. Run under the emulator lock and memory gate with the guarded Herdr lab. For a paid Boat run the same option is supported with the approved upstream/key-file recipe; cleanup must remove the created machine and show the empty provider list. A lab sshd is not proof of a real Boat machine.

For the changed Computers row, open an agent on Desk → Pane actions → Computers while cloud is inactive; capture **Checked when you pick it**, switch, then capture the cloud Home connected. Capture the changed row at both widths, text sizes and themes under the Visual check; the installed PWA must show the phone-app reason instead of offering a dead SSH switch. Keep the integration flow's original failure and deliberate `forgetSshCredential` mutation failure beside the green run.

## Gotchas

- Stand-in agents report lifecycle with `herdr pane report-agent --seq <n>`; seqs must rise, so use `date +%s%N` for both the stand-in and any control command or a late lower seq is ignored.
- In the PWA lab, pair with `window.__MUXR_LAB_PAIR__(link)` (web export built with `EXPO_PUBLIC_MUXR_LAB_PAIR=1`); a reload mid-confirm aborts the flow, so do not reload during a run. At 270 dp tap the Live card, not the Spaces row, to open the agent.
- Keep each lab host in the foreground with its own private `MUXR_HOME`; learn ports from the process that started each relay. Do not touch the owner's service, relay, Herdr session, or pairing data.
- The preview may be long, so its sheet body must scroll to the Start and Cancel controls on the short viewport.
- A target that starts but does not accept the prompt remains visible on that computer; report the cause and leave the source open. Do not retry into a duplicate target agent.
- The first host's home-relative mapped path can be absent on the target. Retry only the start in `~`, never `createCwd`, and say that fallback in the note header.
