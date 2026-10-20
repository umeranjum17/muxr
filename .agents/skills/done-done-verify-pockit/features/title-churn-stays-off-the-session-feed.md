# Title churn stays off the session feed

Part of the pockit verification map. Source: `perf/fake-herdr/stack.smoke.mjs`.

## How to get to it (user POV)

Panes rename themselves constantly while the phone watches the herd; titles show on the tree, not as pushes.

## Driving it

Harness: A Node script (the stack smoke itself) that opens a ws client to the relay with role=client and sends framed requests (client.hello, session.list, herdr.tree, terminal.attach). It also opens the terminal WebSocket for frames.

1. Launch the app as SKILL.md says and wait until it is ready.
2. Node perf/fake-herdr/stack.smoke.mjs (step: wait 5 s, re-read herdr.tree to see renamed titles, and check session.updated pushes stay at 2 or fewer per session).
3. Capture: save the output and exit status to $DONE_DONE_EVIDENCE_ROOT/title-churn-stays-off-the-session-feed.txt, as SKILL.md's Evidence section says.
4. Stop what you started.

The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.
