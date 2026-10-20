# Count local activity without loading the computer

The Usage screen's measured activity for agents the host's own ledger does not
read (Kimi, Gemini, Copilot, Grok and the rest) comes from the pinned offline
ccusage backend. The Home card never starts it; only an open Usage screen does,
one run at a time, at idle CPU and IO priority, and the backend is pointed away
from the Claude, Codex, OpenCode and Pi stores the ledger already counts. A
good answer is reused for 10 minutes, and a failed one stays until a refresh.
Each run is watched and killed past 1 GB resident (Linux `/proc`); one the cap kills reports
"Local activity is too large to count within 1 GB" and the last good count
stays on screen.

The ledger itself (Claude, Codex, OpenCode, Pi) counts in a child process at
nice 19 and idle IO with a 512 MB heap, never on the host's loop. A count
nobody has asked about for 30 s is paused (SIGSTOP) and resumed on the next ask.

## Sub-features

- `card-quiet` the Home card's `usage.now`, refreshed or not, starts no run.
- `one-run` tabs asking together share one run; a run is never started while one is going.
- `idle-priority` the run is nice 19 and, where `ionice` exists, IO class idle.
- `ledger-stores-hidden` `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCODE_DATA_DIR`, `PI_AGENT_DIR` point at one empty store.
- `failure-backoff` a failed run is not repeated on every ask; a refresh re-runs it.
- `memory-cap` a run over 1 GB resident (`MUXR_CCUSAGE_MEMORY_KB` lowers it in tests) is killed and reported as too large. Not `ulimit -v`: Node cannot start under a 1 GB address-space limit.
- `ledger-off-loop` a large Pi store is counted in the child: the host's own CPU barely moves, and the Pi tab shows the numbers.

## How to get to it (user POV)

- Install one agent only ccusage measures (Kimi, Gemini…), pair the phone, open
  Home, then Usage and its tabs; pull to refresh.

## Driving it with the private stack

Preconditions:

- The flow test `apps/host/src/usage/infrastructure/usageNow.test.ts` ("runs
  the daily backend for the Usage screen only…") drives the real collector with
  a stand-in backend and `ionice` on `PATH`; `yarn vitest run` it from
  `apps/host`.
- Memory proof: a lab store of synthetic session logs in the Claude Code layout
  (`<scratch>/labstore/projects/<project>/*.jsonl`, about 1.5 GB) and the real
  `node_modules/@ccusage/ccusage-linux-x64/bin/ccusage daily --by-agent
  --sections daily,session --json --offline --since <date>`. Run it with
  `CLAUDE_CONFIG_DIR=<labstore>` (before) and with the four variables on an
  empty store that holds a `projects/` folder, under `ionice -c 3` (after);
  sample `VmHWM` from `/proc/<pid>/status` and `rchar` from `/proc/<pid>/io`.
- Ledger: the flow test "counts a large Pi store off the host loop, and the Pi
  tab shows it" writes ~180 MB of Pi turns and compares the host's CPU time
  with an empty machine's. On a device, the lab journey opens Usage five times
  then an agent while pinging the host's HTTP `/ping` every 50 ms; the Pi tab
  must leave "Counting local activity".
- Pass: the card starts nothing; peak RSS and bytes read fall to near zero
  after; the Usage screen still shows the ccusage-only agent's tokens.

## Gotchas

- An empty `CLAUDE_CONFIG_DIR` without a `projects/` folder makes the backend
  exit 1 ("No valid Claude data directories found"), which reads as a failed count.
- The lab store is synthetic and lives under the task scratch; the fleet read
  guard blocks any login or config store path, so never point the lab at one.
- The child keeps the host's own environment (`process.env`) and overrides only
  the four store variables; a stand-in backend gets the host's `PATH`.
