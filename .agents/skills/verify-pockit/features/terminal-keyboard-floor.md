# Keep an agent's grid tall enough when the keyboard opens

Pointer only. The pan, cursor-follow and whole-row rules, their proof criteria
and gotchas live in the header of
`apps/mobile/sources/terminal/application/terminalPan.ts`; the row floor lives in
`apps/mobile/sources/terminal/domain/terminalFloor.ts`. The proof procedure and
the remaining sub-feature criteria live in the header of
`features/terminalFloorLab.mjs`, the script that drives the lab.
