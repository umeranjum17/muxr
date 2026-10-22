# Time install to first agent

How long a newcomer's own taps and waits take from a fresh app to the new
agent's composer, on a task-owned emulator with the fake-Herdr stack and a
signed-in `claude` stand-in (no agents, as in [home-first-agent.md](./home-first-agent.md)).

## Sub-features

- `link-to-agent` open the app, open a `muxr://pair#` link, tap Pair, tap
  `Start Claude Code`, reach the agent's Prompt: no system modal between Pair
  and the agent (see [notification-permission.md](./notification-permission.md)).
- `ab-timing` the same run for several builds on the same emulator and load.

## Driving it

Preconditions: release APKs from `node perf/buildPrApk.mjs <out>` (copy one
`test.keystore` into the second out dir so both share a signer), the memory gate,
and the emulator lock: `flock -o -w 3600 /tmp/fm-muxr-emulator.lock
<memory gate> node perf/onboardingTiming.mjs --apk base=<main.apk> --apk
cut=<candidate.apk> --out <evidence dir> --avd-home <scratch dir> --runs 3`.
It boots its own AVD (1080x2376 at density 640), starts one fake stack per run,
clears the app, and writes `timing.json` (steps, every screen change with its
time) and `shots/<label>-<step>.png` for the first run of each build.

## Reading the numbers

- Emulator times are relative: the same build ran 15 s on an idle emulator and
  55-120 s on a loaded one. Compare builds from one hold only.
- Polling a UI dump costs about 1.5 s, so a step under about 2 s is noise.
- The run ends at the composer: the agent's own first answer comes from a real
  model, which a stand-in cannot time honestly.
- A step a person does (tap, read a screen) costs about 2.5 s and 4 s on top of
  these machine times; count the taps and screens a change removes.

## Gotchas

- The lab host inherits the shell's environment: the script drops every
  `CLAUDE*`, `ANTHROPIC*`, `CODEX*` and `OPENAI*` variable, or the host would
  read the shell's own sign-in instead of the stand-in's.
- A loaded emulator ANRs the launcher over the app; the script presses Wait.
