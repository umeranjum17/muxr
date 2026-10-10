# muxr verification map

This directory is the maintained source for verifying the user-facing behavior
of muxr's self-hosted relay/host and public CLI. Read this index before
driving, then use the matching feature file as the recipe.

## Baseline preconditions

- Follow `../SKILL.md` Launch so the stack is private: task-owned
  `MUXR_HOME`, relay on a kernel-picked port learned from the child's stdout,
  host on `--fake`, naming on a private port.
- Every CLI call is `node scripts/cli.mjs …` from the repo root with the same
  `MUXR_HOME`. Treat commands as literal; keep quoted names and flags
  unchanged.
- `muxr doctor`-style checks pass (`/health` ok, version matches, one online
  host). Never drive an instance this run did not start.
- For pane-scoped commands, run inside a Herdr pane of a non-default session
  you own, so `HERDR_PANE_ID` arrives the way every real pane gets it.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say
  otherwise.
- Prefer public flags and running services over internal state: no mocks, no
  test-only endpoints, no editing files under `MUXR_HOME` to force a result.
- Capture the command, its stdout/stderr/exit code, and the durable side
  effect through a second read-only user-facing view.
- Report a skipped entry point with the attempted command and the unmet
  precondition; never report it as verified through a different path.

## Proof and skip reporting

- Mutation proof always pairs the action (CLI output) with the stored result
  (`$MUXR_HOME` paths, relay owner API listings).
- Failure-path proof includes the exact failing input, its stderr, and exit
  code 1 — a missing target must fail loudly, not silently.
- Evidence lives outside the scratch `RUN_ROOT` and survives cleanup.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the
user-visible behavior, then exactly four H2 sections in this order:
`Sub-features`, `How to get to it (user POV)`, `Driving it with the private stack`
(starting with `Preconditions:`), and `Gotchas`.

## Features

- [Connect an older phone without optional UI plugins](./retired-ui-compatibility.md) —
  all five legacy replies over a real paired host, then released Android Home/session acceptance.
- [Open agent pages on the normal desktop](./agent-desktop.md) —
  guarded real-Herdr launch environment evidence; all launch families,
  plan-account moves and headless device mirrors stay isolated.
- [Read a plain Computer failure](./computer-failure.md) —
  real native release app against a guarded Linux lab without ScreenCast:
  plain cause and next step, Try again, themes and 270dp/font 1.3.
- [Select a safe development Herdr session](./dev-herdr-guard.md) —
  direct socket guard proof without launching a stack; no baseline needed.

- [Reload the installed PWA with no network](./pwa-offline.md) —
  standalone-window PWA over the owned relay serving `dist`: boot-registered
  worker, versioned shell, offline reload, self-recovery, and a build update.

- [See the themed splash on a cold PWA start](./pwa-splash.md) —
  standalone-window PWA over a static `dist`: no-JS first paint, throttled cold
  start in both themes at 393 and 270 px, offline hand-off, native comparison.

- [Install muxr to the home screen from a browser tab](./pwa-install.md) —
  exported web client in Chrome and emulated iOS Safari: prompt row, Add to
  Home Screen guide, hidden once installed or with no install path, at 393 and
  270 px, light and dark.

- [Share a file into a pane's Shared Artifacts](./shared-artifact.md) —
  `muxr share`, collision suffixes, dotfile rename, missing-target failure,
  versioned page shares and their refusals, and the retention view of the
  same timeline.
- [Scan a pairing QR from the terminal](./pairing-qr.md) —
  `muxr pair` at normal/narrow widths and inside an isolated Herdr terminal.
- [Read the pairing consent as short, plain bullets](./pairing-consent.md) —
  native release APK and PWA over a private stack: phone and browser control and
  view-only consent, plain copy, at 360dp/270dp font 1.3 and 393/270 px, dark and light.
- [Check the self-host](./selfhost-health.md) — relay `/health`, version
  identity, and the owner-only hosts listing.
- [Name the current workspace and pane](./agent-naming.md) — `muxr name`
  inside a Herdr pane, with provider/model attribution.
- [Inspect and prune Shared Artifacts history](./artifact-retention.md) —
  `muxr artifacts status` / `prune`.
- [Ask whether the phone is driving this pane](./preview-status.md) —
  `muxr preview status` against the naming loopback.
- [Watch and drive an iOS Simulator from the phone](./ios-simulator-preview.md) —
  `muxr preview claim` on a macOS host, live stream, tap/swipe/Home, clean
  helper shutdown.
- [See only device preview chips, never a Browser one](./device-preview-not-browser.md) —
  native release app over a guarded lab: device chips still work, the retired
  Browser presence/URL stays unavailable, and Computer reads `Computer` from
  shell and agent entry.
- [See pinned spaces on the phone's Spaces list](./spaces-pinned.md) —
  native app on an emulator over a private stack: pin, themes, tablet width,
  plus guarded two-computer pin isolation and legacy migration.
- [Read the computer name in the Home header](./home-header-name.md) —
  native app over a named fake-Herdr stack: one line with an ellipsis, at
  270dp and font scale 2.0, light and dark.
- [Read plan limits on the Home card](./home-quota-row.md) —
  native app and PWA over a fake-Herdr stack with a stand-in Codex: window
  first, whole-item wrap, no ellipsis, at 270dp and font 1.3/2.0, both themes.
- [Read a space's agent count whole on Home](./home-spaces-count.md) —
  native app and PWA over a fake-Herdr stack: the count stays whole while the
  path chip ellipsizes, at 270 and 393 wide and font 1.3/2.0, both themes.
- [Add a second Claude account on iPhone and iPad](./accounts-ios.md) —
  Release simulator app over a fake-Herdr stack: the Added notice names
  accounts as the list does, light and dark, before/after one build.
- [See what runs your sessions from Settings](./settings-herdr-info.md) —
  Settings `Herdr` row and sheet with the `herdr agent list` command, Copy
  feedback, and the real-Herdr lab log proving the command lists the host's
  sessions.
- [Read the connection route on the phone](./connection-route.md) —
  Settings > Connection names the route as `muxr setup` does: dev client on
  an emulator over a real lab host, themes and 270dp/font 1.3.
- [Keep a terminal pane alive across a reconnect](./terminal-reconnect.md) —
  native app over a private stack: relay and host restarts under an
  open pane, last frame kept, recovery with no tap, plain words.
- [Stay connected to a busy computer](./busy-computer.md) —
  homeLoad at 300 panes / 150 agents, then a frozen lab host on an emulator:
  busy card through the offline grace, explanation only after it.
- [Select a terminal's text on iOS](./terminal-select-text-ios.md) —
  Select Text viewer: Select All, one-tap Copy and a read-only edit menu on
  iPhone and iPad simulators.
- [Read a Live preview with no output](./live-preview-empty.md) —
  native release app and PWA over a fake-Herdr stack whose pane reads empty:
  a calm placeholder and a plain line, themes and 270dp/360dp, live output
  unchanged.
