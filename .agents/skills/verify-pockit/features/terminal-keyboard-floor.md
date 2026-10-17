# Keep an agent's grid tall enough when the keyboard opens

Pointer only. The rules live in the header of
`apps/mobile/sources/terminal/application/terminalPan.ts` (pan, cursor follow,
whole rows) and `apps/mobile/sources/terminal/domain/terminalFloor.ts` (the row
floor). The proof procedure, sub-feature criteria and gotchas live in the header
of `features/terminalFloorLab.mjs`, the script that drives the lab.
