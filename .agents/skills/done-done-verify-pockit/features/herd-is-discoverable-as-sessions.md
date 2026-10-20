# Herd is discoverable as sessions

Part of the pockit verification map. Source: `perf/fake-herdr/stack.smoke.mjs`.

## How to get to it (user POV)

Phone opens Home after pairing and the host lists the herd; in the proof, the scripted client sends session.list over the relay.

## Driving it

Harness: A Node script (the stack smoke itself) that opens a ws client to the relay with role=client and sends framed requests (client.hello, session.list, herdr.tree, terminal.attach). It also opens the terminal WebSocket for frames.

1. Launch the app as SKILL.md says and wait until it is ready.
2. Node perf/fake-herdr/stack.smoke.mjs (step: request session.list, check count matches the fake herd's panes and agents).
3. Capture: save the output and exit status to $DONE_DONE_EVIDENCE_ROOT/herd-is-discoverable-as-sessions.txt, as SKILL.md's Evidence section says.
4. Stop what you started.

The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.
