# Agent terminal and shell terminal stream live

Part of the pockit verification map. Source: `perf/fake-herdr/stack.smoke.mjs`.

## How to get to it (user POV)

Phone taps an agent card or a shell pane from the herd; in the proof, the client sends herdr.tree then terminal.attach and reads terminal frames.

## Driving it

Harness: A Node script (the stack smoke itself) that opens a ws client to the relay with role=client and sends framed requests (client.hello, session.list, herdr.tree, terminal.attach). It also opens the terminal WebSocket for frames.

1. Launch the app as SKILL.md says and wait until it is ready.
2. Node perf/fake-herdr/stack.smoke.mjs (step: attach an agent pane from herdr.tree, then attach a shell pane and read frames containing 'frame-').
3. Capture: save the output and exit status to $DONE_DONE_EVIDENCE_ROOT/agent-terminal-and-shell-terminal-stream.txt, as SKILL.md's Evidence section says.
4. Stop what you started.

The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.
