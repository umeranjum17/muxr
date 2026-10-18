# Show a stalled computer as busy and recovering

A paired iPad can stay on Home while Herdr stops answering: muxr marks the runtime unavailable, says it is likely busy and reconnecting on its own, then restores the live agents after Herdr answers again without a desktop step.

## Sub-features

- A ready Herdr that becomes silent changes the host's existing `herdr.tree.connected` value to false, then back to true on recovery.
- Home uses the existing busy/reconnecting card during the 10-minute grace bound and does not show a restart command; after the bound it uses the normal runtime recovery card.
- The host journals the stalled and recovered transitions once each.

## How to get to it (user POV)

- Pair the muxr iOS app to a self-hosted computer and leave Home open with live agents.
- If Herdr stalls, Home says the computer is likely busy and reconnecting on its own. When Herdr resumes, the live agents return without a desktop action.

## Driving it with the private stack

Preconditions: Use the parent skill's iOS Simulator path with a task-owned simulator, private `MUXR_HOME`, one relay, one host, and a named Herdr lab session. Never use the default Herdr session or a relay/host outside this run.

- Run `node scripts/diagnostics/application/checkHerdrStallE2E.mjs` inside the named Herdr lab. Its first phase SIGSTOPs only the lab Herdr, requires `herdr.tree.connected === false` within 20 seconds, resumes Herdr, then requires a healthy tree and working attach within 10 seconds. Its second phase freezes the lab stack for 60 seconds and verifies automatic link and attach recovery.
- On the task-owned iPad simulator, keep Home open during the first Herdr freeze; record the busy/reconnecting card and the live agents returning after SIGCONT, with no desktop action. Capture Home in dark and light as described by the parent skill.
- For the bounded overload check, request a window from the lane owning the load. Do not create heavy load in this verification.

## Gotchas

- A false runtime liveness value is distinct from a disconnected phone link. Preserve the link and use the existing Home busy card until the 10-minute bound.
- `herdr: answering again` is emitted from the kit's `stalled` to `ready` transition, not from counting unrelated API call timeouts.
