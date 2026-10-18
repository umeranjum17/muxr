# Hand a conversation to another computer

The phone asks the host to continue an agent on another computer: `session.handoff` makes the agent write its own handoff note (goal, done, left, decisions, folder and branch) and returns it. The agent must be idle or done; a busy agent is refused before anything is typed, with `handoff-busy`, and a turn that times out or cannot read its note is reported as `handoff-failed`, with nothing retried.

## Sub-features

- A conversation that is working is refused with `handoff-busy` and no prompt is sent.
- The note is returned from the agent's own result file, and that file is removed afterwards.
- A note that is missing, unreadable or over the size limit is refused with `handoff-failed` and the agent stays where it was.
- The fake development source answers the same request, so the phone flow runs without Herdr.

## How to get to it (user POV)

The phone's handoff action sends `session.handoff` for the open conversation and the target computer's name. There is no terminal command for it; the request exists on the link, so drive it through a paired lab device link as below.

## Driving it with the private stack

Preconditions: a guarded non-default Herdr lab from `fm-herdr-lab.sh` (`name`, `provision`, `teardown`); a built host and relay; the repo's `linkHerdrLab` harness with `HERDR_LAB_HELPER` set to that helper. Never the `default` session, `muxr.service` or relay 8792.

1. Start a lab shell session with `session.start` `{ cwd, kind: 'shell', label }` and read its `paneId` from the result.
2. Run the stand-in in that pane as a process named `pi`: copy `handoffStandIn.sh` to a scratch directory as `pi` and run `herdr pane run <paneId> "<scratch>/pi <lab wrapper>"`. Wait until `session.list` shows that pane with `agentKind: pi`, `agentStatus: idle` and `promptable: true`, and use that row's `id`, not the id `session.start` returned.
3. `session.handoff` `{ sessionId, targetName }` returns `{ note }`. The session's cwd must hold no `.byokit-turn-*.json` afterwards.
4. Make the stand-in report `working` (`herdr pane report-agent --source verify-standin --agent pi --state working <paneId>`), then repeat the call. Expect the coded error `handoff-busy` and a stand-in log with no new prompt line. Report `idle` again.
5. Stop by exact PID what the harness started, and check `herdr session list` shows the lab session stopped or absent. The default session must still be running.

Save the command outputs and the stand-in log in the task evidence directory. Do not save the link grant or the offer.

## Gotchas

- The stand-in must be a process named `pi`. Herdr refuses `agent prompt` for a foreground process of another name, and the kit then never types the prompt.
- The `pi` process name matters for the kit's turn, not the note text: the note is whatever the stand-in writes, so this proves the path, not what a model would say.
- Request params must be an object even when empty (`{}`). A missing one fails the frame shape check, and the host answers `not-allowed`, which looks like a permissions problem.
