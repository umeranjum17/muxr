# Closed panes leave no host session bookkeeping

Opening and closing many panes must not leave timestamp or event-sequence entries for their retired routes. This bounds that small source of host memory growth; it is not proof that every other source of memory growth is fixed.

## Sub-features

- A removed session releases its last-modified timestamp.
- Its final removed event retains its sequence number, then releases the sequence counter.
- A real host returns both retained-entry counts to baseline after 30 pane generations have been discovered, closed and announced over the real encrypted link.

## How to get to it (user POV)

Open and close panes on the computer while the phone stays paired. Closed panes disappear without their per-session host bookkeeping accumulating forever.

## Driving it with the private stack

Preconditions: built host/relay and an authorized Herdr lab helper. Follow the skill's isolation contract; this check provisions its own named lab unless HERDR_LAB_PREPROVISIONED explicitly assigns an already-owned lab.

Run `HERDR_LAB_HELPER=<guarded helper> node scripts/diagnostics/application/checkHerdrSessionRetention.mjs`. It starts its own real relay, host and paired device, leaves one pane as its baseline, then discovers and closes 30 additional real panes. It reads the real timestamp/sequence owners through a debugger tap in the child host, without replacing the source or adding a product endpoint.

Success: exit 0 and `PASS: 30 real pane generations close without retaining timestamp or sequence entries`. To prove the check catches the old behavior, restore either removed-session map write without its deletion, rebuild, and require failure at `retired generation bookkeeping released` before restoring the candidate.

## Gotchas

- A tree with no closed panes is insufficient: it passed while both bookkeeping maps retained every old route. The final retained-owner counts are the regression assertion.
- The counts describe two small maps, not total RSS, a 50-agent latency result, native phone rendering, or a kit backlog leak. Those require their own real-load evidence.
- This backend-only change has no themed or visual surface; visual check: n/a (no UI change).
