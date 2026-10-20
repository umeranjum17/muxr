# Dropped files appear in Shared Artifacts

Part of the pockit verification map. Source: `perf/fake-herdr/stack.smoke.mjs`.

## How to get to it (user POV)

A file lands in a pane's attachment folder; the phone's Shared Artifacts list for that session shows it.

## Driving it

Harness: A Node script (the stack smoke itself) that opens a ws client to the relay with role=client and sends framed requests (client.hello, session.list, herdr.tree, terminal.attach). It also opens the terminal WebSocket for frames.

1. Launch the app as SKILL.md says and wait until it is ready.
2. Node perf/fake-herdr/stack.smoke.mjs (step: write a PNG into the pane's attachment dir, then wait for an artifacts.update event and call artifact.list, expecting metadata only).
3. Capture: save the output and exit status to $DONE_DONE_EVIDENCE_ROOT/dropped-files-appear-in-shared-artifacts.txt, as SKILL.md's Evidence section says.
4. Stop what you started.

The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.
