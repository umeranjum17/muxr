# Keep a shell request's backgrounded child from outliving it

A `machine.shell` request (Home's worktree probe) and a `session.shell` request
run the command in its own process group and kill that group when the request
ends. A command that backgrounds a child (`npm run dev &`, a git hook, a dev
server) no longer leaves it orphaned in the host's systemd unit, and the reply
no longer hangs on that child's stdout pipe — the phone gets a prompt answer
instead of `Your computer didn't answer in time.`

## Sub-features

- `machine.shell` with a backgrounded child answers promptly and the child is
  gone once the reply arrives.
- The host's unit memory and process count stay flat across repeated such
  commands; on the pre-fix host both climb (the 2026-10-08 systemd-oomd shape).
- A command with no backgrounded child is unchanged.
- A long-running foreground command still runs to completion; the group is only
  killed on exit or timeout.

## How to get to it (user POV)

On the phone, start a worktree in a folder whose shell or git hook backgrounds
work, or run a command that starts something in the background. The request
returns its output, and the computer's memory does not climb.

## Driving it with the private stack

Preconditions: follow `../SKILL.md` isolation and run `yarn build` so
`apps/relay/dist/main.js` and `apps/host/dist/main.js` exist. Use
`perf/lib/fakeStack.mjs` (real relay and host from this checkout, fake Herdr),
never the owner's host.

1. Answer-time and reap proof: `node .agents/skills/verify-pockit/features/hostShellGroupLab.mjs`.
   Expect `PASS machine.shell replied in <ms> and reaped backgrounded child <pid>`.
   The payload backgrounds a 64 MiB sleeper and records its pid; the lab fails
   if the reply takes over 8 s or the pid is still alive.
2. Unit-memory shape: run the same path as a transient systemd user service and
   sample the unit cgroup (`perf/memUnitLab.mjs --mode grandchild`). Unit memory
   and `nprocs` stay flat on the fix and climb with every leaked child on the
   pre-fix host.

## Gotchas

- The payload must name an absolute interpreter: a mise `python3` shim chooses
  its tool from `argv[0]` and does not survive being backgrounded, so the leak
  is invisible with a shimmed interpreter.
- A leaked child is reparented to the systemd user manager but stays charged to
  the unit's cgroup; only the process-group kill reaches it.
- A deliberate background in a `machine.shell`/`session.shell` request
  (`npm run dev &`) is ended when that request ends. No shipped muxr flow
  relies on a request's backgrounded child surviving it.
