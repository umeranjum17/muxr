# First run exits

A person who finishes the first-run setup from bare `muxr` lands back at their
shell on the line "Open muxr on your phone and tap Start". If setup left nothing
saved (cancelled), the main menu still opens.

Drive: `done-done run first-run-exit` (no emulator). `firstRunExitLab.mjs` runs
the real `scripts/cli.mjs` on a pty in a private `MUXR_HOME`, once per outcome.
Only the setup wizard's apply step is stood in (`firstRunExitSetup.mjs`), because
the real one installs services.

Prove: `first-run-finish.txt` ends with `muxr exit 0` and has no "What would you
like to do?"; `first-run-cancel.txt` shows that menu. Restoring `for (;;)` in
`scripts/cli.mjs` turns the journey red.

Not covered: the real apply step (service install, Tailscale), which stays out
of reach of a lab by rule.
