# Herdr journeys on Herdr Core: port or retire

Plan step 2 of the Herdr Core switch (`data/muxr-herdr-core-design/report.md` section 8).
Each journey that drives Herdr gets a Herdr Core version, or is retired with its reason.

The ports land with plan step 3 (the switch). Until the host reads Herdr Core, a journey
moved to the core would see an empty Home. Step 2 ships the rig the ports use and proves it
end to end: [herdr-core-lab.md](herdr-core-lab.md).

## Which journeys

The set is every journey script under `features/` that mentions Herdr at this head:
`git grep -l -i herdr -- '.agents/skills/done-done-verify-pockit/features/*.mjs' '.agents/skills/done-done-verify-pockit/features/*.sh'`,
leaving out `herdrCoreLab.mjs` itself. That gives 55 files.

The design report's figure (47 of 61 journeys, 7,693 lines) did not reproduce under any file
set tried. Its method is recorded only as "mention herdr". This table is the larger,
reproducible set, so none of the report's 47 is left out.

Outside `features/`, three more callers port in step 3:
- `phone-attach` (`scripts/diagnostics/application/checkPhoneAttach.mjs`);
- the suite's live-Herdr checks (`runSuite.mjs`, `devHerdrSocket`);
- `perf/fake-herdr` itself, which step 3 deletes.

## How a journey moves (the rigs)

- **fake**: `startFakeStack()` over `perf/fake-herdr`.
  - Core version: `startFakeStack({ herdrCore: true })`. Seed the same world into
    `stack.herdrCore` with `terminal.run` and the `herdr.space` / `herdr.tab` labels, using a
    stand-in agent that reports status over OSC 7501 (the one in `herdrCoreLab.mjs`).
  - Step 3 points the host at `stack.herdrCore.socket`.
- **lab**: a real Herdr TUI lab (`linkHerdrLab`, `HERDR_LAB_HELPER`).
  - Core version: `startHerdrCore()`. Each Herdr TUI command maps to a Core call:

    | Herdr TUI | Herdr Core |
    |---|---|
    | `herdr workspace/tab/pane create` | `terminal.run {labels}` |
    | `pane send-text` / `read` | `terminal.send` / `terminal.read` |
    | `pane report-agent` | OSC 7501 from the agent |
    | `HERDR_PANE_ID` | `HC_TERMINAL_ID` |
    | `herdr.rename` | `terminal.label` plus the `herdr-app` document |

- **stub**: a `herdr` stand-in on PATH. The Core version is an `hc` stand-in, because setup,
  doctor and triage check Herdr Core after step 3.
- **two machines**: two lab computers become machines on one core (`hc machine add`, plan
  step 4).
- **none**: Herdr appears only in a comment or a capture filter. The journey stays as it is.

## The table

| Journey script | done-done journey | Rig today | Verdict | Herdr Core version |
|---|---|---|---|---|
| accountsCliLab.mjs | (by hand) | lab | port | Core lab; Claude terminals with plan-folder cwd; `muxr accounts` reads them via the host |
| accountsLab.mjs | (by hand, iOS) | fake | port | fakeStack + core; second account seeded as a labelled terminal |
| actionSheetLab.mjs | action-sheet | fake | port | fakeStack + core |
| addAccountLab.mjs | add-account | lab | port | Core lab; the sign-in tab is `terminal.run` of the stand-in `claude` |
| boardAlertLab.mjs | board-alert | fake | port | fakeStack + core |
| boatSignInLab.mjs | (by hand) | lab | port | Core lab beside the fake Boat server; the Boat box joins over SSH (step 4) |
| browserPairLab.mjs | (by hand) | fake | port | fakeStack + core |
| chatFakeLab.mjs | (used by header fit) | fake | port | fakeStack + core; seeded Claude log beside a labelled terminal |
| chatHarnessesPwaLab.sh | chat-harnesses-pwa | fake | port | fakeStack + core, one stand-in per harness kind |
| chatLab.mjs | (by hand) | lab | port | Core lab |
| chatRealAgentLab.mjs | (by hand) | lab | port | Core lab with the real `pi` |
| chatSlicePwaLab.sh | chat-slice-pwa | fake | port | fakeStack + core; model read from the agent's status record, not Herdr's pane |
| chatWorkingPwaLab.sh | chat-working-pwa | fake | port | fakeStack + core |
| cloudMachineLab.mjs | (helper) | stub | port | the stand-in Boat box gets sshd and joins with `hc machine add` (step 4) |
| cloudMachinesNativeLab.mjs | cloud-machines | lab | port | two machines: Boat box joined to the main core, listed from `machine.list` |
| cloudSetupLab.mjs | cloud-setup, cloud-boat, cloud-boat-screen, cloud-screen-switch, ssh-boat-return, ssh-computer-return | lab | port | two machines: the SSH set-up becomes add-a-computer (step 4) |
| computersLab.mjs | (by hand) | fake | port | two machines: the Computers sheet lists Core machines; per-computer pairing is deleted in step 3 |
| demoFirstRunPwaLab.sh | demo-first-run-pwa | none | unchanged | needs no Herdr (comment only) |
| desklinkPinLab.mjs | desklink-pin | lab | port | Core lab under the host |
| firstInstallLab.mjs | first-install | stub | port | `hc` stand-in: setup installs Herdr Core |
| handoffStandIn.sh | (helper for session-handoff) | lab helper | retire | `herdr pane report-agent` is Herdr TUI only; the OSC 7501 stand-in in `herdrCoreLab.mjs` replaces it |
| headerFitNativeLab.mjs | (by hand) | fake (via chatFakeLab) | port | follows chatFakeLab; the `/tmp/muxr-perf-` capture filter stays |
| herdSentenceLab.mjs | (by hand) | fake | port | fakeStack + core; Working/Done from Core status |
| herdrCloseLab.mjs | (by hand) | Herdr TUI API | retire | the pane→tab→workspace close ladder (`agentClose.ts`) is deleted; Core close is `terminal.kill`, run in herdr-core-lab |
| herdrLayoutLab.mjs | (by hand) | Herdr TUI API | retire | `layoutApply` / `layoutSelfCheck` are deleted; Core splits live in the `herdr-app` document, which gets a new journey in step 3 |
| herdrStartLab.mjs | (by hand) | Herdr TUI API | port | agent and shell start become `terminal.run {argv, cwd, labels, keep}` (herdr-core-lab step 4 is its core half) |
| herdrStatusLab.mjs | (by hand) | Herdr TUI API | retire | prints `herdrSessionSource` changes, which is deleted; the Core event stream is checked in herdr-core-lab step 9 |
| homeHerdSentenceJourney.sh | home-herd-sentence | fake | port | follows its two halves below |
| homeHerdSentenceNative.mjs | (part of home-herd-sentence) | fake | port | fakeStack + core |
| homeHerdSentencePwaCells.sh | (part of home-herd-sentence) | fake | port | fakeStack + core |
| homeHerdrOutdatedLab.mjs | home-herdr-outdated | fake | retire | the out-of-date Herdr TUI server card goes; Core's minimum version and generation check gets its own journey in step 3 |
| homeTailscaleOffLab.mjs | home-tailscale-off | fake | port | fakeStack + core |
| homeVersionLineLab.mjs | home-version-line | fake | port | fakeStack + core |
| homeVersionLinePwaCells.sh | home-version-line-pwa | fake | port | fakeStack + core |
| hostShellGroupLab.mjs | (by hand) | fake | port | fakeStack + core; `machine.shell` becomes `terminal.run` of a shell with the space label |
| moveLab.mjs | (by hand) | lab, two hosts | port | two machines: Move is rebuilt on `hc file write` and `terminal.run {on}` |
| moveToComputerPwaLab.mjs | move-to-computer | lab, two hosts | port | two machines, as moveLab |
| opencodePermissionLab.mjs | (by hand) | lab | port | Core lab with the real OpenCode |
| paneAccountChipLab.mjs | pane-account-chip | lab | port | Core lab; the chip reads the terminal's account label |
| paneAccountHostLab.mjs | pane-account-host | lab | port | Core lab; `herdr.tree` becomes the Core terminal list |
| paneMenuLab.mjs | pane-menu | fake | port | fakeStack + core; the Panes row (`n/N`) comes from the `herdr-app` layout |
| paneSwitcherLab.mjs | pane-switcher | fake | port | fakeStack + core; panes from the `herdr-app` layout, New pane = `terminal.run` with the tab's labels |
| paneTabNamesLab.mjs | (by hand) | lab | port | Core lab; names from labels and the `herdr-app` document |
| planMoveLab.mjs | plan-move | lab | port | Core lab; relaunch on the other account is `terminal.run` with the resume label |
| sendFeedbackNativeLab.mjs | send-feedback | lab | port | Core lab |
| sendFeedbackPwaLab.mjs | (by hand) | lab (via sendLab) | port | follows sendLab |
| sendLab.mjs | (shared stage) | lab | port | Core lab with the Claude stand-in |
| sendLatencyLab.mjs | send-latency | lab (via sendLab) | port | follows sendLab; the echo time is read from the attach stream |
| terminalFloorLab.mjs | (by hand) | lab | port | Core lab with the real OpenCode |
| terminalLatestLab.mjs | (by hand) | lab | port | Core lab; scrollback is what attach sends with `history` |
| terminalScrollLocalLab.sh | terminal-scroll-local | lab | port, one scene retired | the Claude-pane wheel walk ports; the `KIND=shell` scene, which walks Herdr's own viewport through `terminal.scroll-state`, is retired because Core has no viewport call |
| triageLab.mjs | triage | stub | port | `hc` stand-in |
| twoDoorsLab.mjs | two-doors | lab | port | Core lab with the `claude` stand-in |
| workspaceNameHostLab.mjs | workspace-name-host | lab | port | Core lab; `muxr name` writes `hc label "$HC_TERMINAL_ID"`; the workspace keeps its name |
| workspaceNameLab.mjs | workspace-name | lab | port | Core lab, as workspaceNameHostLab, on the phone |

Totals:
- 55 scripts.
- 49 port. One of them, terminalScrollLocalLab.sh, loses one scene.
- 5 are retired: handoffStandIn.sh, herdrCloseLab.mjs, herdrLayoutLab.mjs, herdrStatusLab.mjs, homeHerdrOutdatedLab.mjs.
- 1 is unchanged: demoFirstRunPwaLab.sh.

Each retired script is deleted in the step 3 change that removes the Herdr TUI code it
tests, and that change names it.
