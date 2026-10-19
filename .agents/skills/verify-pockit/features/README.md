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
(starting with `Preconditions:`), and `Gotchas`. A pointer file is valid instead:
an H1, and one paragraph naming the source headers or lab scripts that hold the
rules, with no H2 sections.

## Features

- [Add your computer from the phone](./add-your-computer.md) —
  release APK on an emulator, lab site with a catalog fixture and the local
  AppImage: link and QR on the phone, `/desktop` download, real scan of the
  desktop's QR, timed tap-to-paired, and a 270dp font 2.0 unreachable-relay
  failure that recovers with Try again; absent on web/PWA.
- [Pair the phone from the installable desktop app](./linux-desktop-app.md) —
  a Linux AppImage wrapping the relay and host (the `/desktop` page names the
  FUSE 2 fallback, `--appimage-extract-and-run`): launch→Ready timing with and
  without Herdr, Install Herdr from the window, QR and two-word pairing with a
  release APK on an emulator,
  Paired and Needs-attention states, and keep-awake/start-at-login persistence.
- [Connect an older phone without optional UI plugins](./retired-ui-compatibility.md) —
  all five legacy replies over a real paired host, then released Android Home/session acceptance.
- [Open agent pages on the normal desktop](./agent-desktop.md) —
  guarded real-Herdr launch environment evidence; all launch families,
  plan-account moves and headless device mirrors stay isolated.
- [Install a missing Herdr without a terminal](./home-herdr-missing.md) —
  desktop app with Herdr hidden: one plain sentence on the window and the
  paired phone's Home, offline Try again, real published install, Home
  recovers and lists the agent with no restart.
- [Read a plain Computer failure](./computer-failure.md) —
  real native release app against a guarded Linux lab without ScreenCast:
  plain cause and next step, Try again, themes and 270dp/font 1.3.
- [Say plainly when the network has no path for the Computer picture](./computer-no-video-path.md) —
  installed PWA in a UDP-less network namespace: the no-path message, Try
  again, 270dp, largest text; a release APK on an emulator with UDP dropped:
  the picture over the link.
- [Keep a tapped desktop field above the keyboard in Computer](./computer-keyboard-fit.md) —
  native Release app on an iPhone simulator, landscape, five fresh launches:
  the tapped password field stays above the keyboard and takes typed text.
- [Hand a conversation to another computer](./session-handoff.md) —
  the agent writes its own handoff note over a real lab Herdr with a stand-in agent; busy agents refused with handoff-busy and no prompt sent.
- [Approve a lab device pairing from the lab helper](./lab-device-approval.md) —
  the lab helper hands its pairing offer to an external device and answers the
  computer approval; the host reports the device it approved.
- [Select a safe development Herdr session](./dev-herdr-guard.md) —
  direct socket guard proof without launching a stack; no baseline needed.
- [Keep a source-build host off the real muxr home](./host-home-guard.md) —
  built host under a throwaway HOME, refused without MUXR_HOME, runs with one.
- [Follow a Herdr agent's status live](./herdr-live-status.md) —
  host session source on a guarded lab Herdr: tree follows new panes, status
  working/blocked/idle lands, socket count 1 → 2 → 1; no baseline needed.
- [Show a stalled computer as busy and recovering](./herdr-stall-recovery.md) —
  named Herdr lab freeze: tree goes unavailable within 20s, returns healthy and
  attaches within 10s; iPad Home records busy copy and agents recovering alone.

- [Read the desktop receiver's decoder and frame rate (developer probe)](./desktop-decoder-probe.md) —
  developer-mode-only machine row and `/debug/decode` route: absent until ten
  taps enable dev mode, then the live receiver reports `VideoToolbox`/H.264,
  picture size and rising frame counters from the private fake stack.

- [Reload the installed PWA with no network](./pwa-offline.md) —
  standalone-window PWA over the owned relay serving `dist`: boot-registered
  worker, versioned shell, offline reload, self-recovery, and a build update.

- [Pair a lab PWA from a plain-http origin](./lab-browser-pairing.md) —
  lab-only `__MUXR_LAB_PAIR__` hook that stores the Hosted Grant through
  `webSecureStore`; the one supported path around the HTTPS-only pair screen,
  absent from production exports, used by the PWA features below.

- [Start the first agent from Home in one tap](./home-first-agent.md) —
  fresh release app paired to the fake-Herdr stack with no agents and a lab
  `claude` stand-in: `Start Claude Code` opens the agent with no picker; signed
  out, one plain sentence plus `Check again` turns into the one-tap offer in
  place; timed Home-to-agent screenshots on main and the candidate; installed
  PWA at 393 and 270 px, light and dark.

- [Deliver the Home composer's prompt to the agent it starts](./home-composer-first-prompt.md) —
  release app on a task-owned emulator paired to a real-Herdr lab: a prompt
  sent from Home opens the new OpenCode agent at once with `Prompt queued`;
  the prompt is delivered once the agent is ready, Home is free after spawn,
  and if it cannot be, the text returns to Home's composer and the agent's
  draft marked not sent.
- [Long silence never fills the composer](./dictation-silence-gate.md) —
  `dictationLab.mjs` on a task-owned emulator: file-fed Silero speech gate on
  the phone's Whisper finals. Near-silence leaves the draft empty while quiet and
  clean still transcribe, on a clean install and over old data. Status and
  evidence: see the feature doc.

- [Name agents on Home by kind and task, never a launch id](./home-agent-labels.md) —
  paired lab PWA over a real-Herdr lab with an unnamed Codex and pi agent: the
  `Ready · unseen` rows read the kind/task and never a `pp_*` id, and an agent
  with no published name reads its kind, else its folder, else `Agent`, never
  `Unnamed agent`, at 393 px light and dark.

- [Show the needs-you count on the installed PWA's app icon](./pwa-badge.md) —
  a paired lab PWA over a fake herd: recorded `setAppBadge`/`clearAppBadge`
  calls for `0 → 1 → 2 → 1 → 0`, at 393 px light and dark.

- [See the themed splash on a cold PWA start](./pwa-splash.md) —
  standalone-window PWA over a static `dist`: no-JS first paint, throttled cold
  start in both themes at 393 and 270 px, offline hand-off, native comparison.
- [Paint the installed PWA landing without the terminal payload](./pwa-coldstart.md) —
  static `dist`: the initial-transfer gzip ratchet, the eager entry/`__common`
  carrying no xterm/shiki/diff/CanvasKit, the session route still loading its
  lazy terminal chunks at runtime, and non-slim diff grammars fetching on
  demand from `/shiki-langs/` only when a diff needs them.

- [Install muxr to the home screen from a browser tab](./pwa-install.md) —
  exported web client in Chrome and emulated iOS Safari: prompt row, Add to
  Home Screen guide, hidden once installed or with no install path, at 393 and
  270 px, light and dark.

- [Show one needs-you count on the app, the favicon and the PWA icon](./needs-you-count.md) —
  private fake stack with a lab-only `lab.set_agent_status`: blocked, failed and
  uncovered-request herds drive the Needs you list, the Spaces header, the
  favicon dot and the recorded app badge to the same number, light and dark at
  393 and 270 px.

- [Share a file into a pane's Shared Artifacts](./shared-artifact.md) —
  `muxr share`, collision suffixes, dotfile rename, missing-target failure,
  versioned page shares and their refusals, and the retention view of the
  same timeline.
- [Send any file from the phone to a live agent](./attach-any-file.md) —
  the composer's `+` offers Photo Library and Files: a zip, pdf and txt land on
  the host with their original names against a live Herdr agent that opens each
  with no permission prompt (OpenCode's external-directory pre-allow), the saved
  paths carry an opaque digest folder and never the internal pane id, the 10 MB
  cap refuses a larger file on the phone, and the host backstop holds;
  images keep their resize/thumbnail path, chips at 393/270 px light and dark.
- [Pair a phone through the kit files](./pairing-handoff.md) —
  non-TTY `--handoff`, raw two-word kit delivery, verified enrollment,
  mismatch/deadline/cancellation cleanup, and missing-setup startup in a container.
- [Scan a pairing QR from the terminal](./pairing-qr.md) —
  `muxr pair` at normal/narrow widths and inside an isolated Herdr terminal.
- [Paste an http pairing link](./pair-http-link.md) —
  the plain-http wrapper a ws:// relay prints (`muxr pair --browser` on a LAN
  self-host or lab) pastes into the Pair form and reaches consent on the PWA,
  while a truly truncated token still names the cut-off code.
- [Lead every pair entry with Scan](./pair-scan-first.md) —
  which action leads on each way into pairing, Scan a new code after an expired
  or refused code (an unanswered code says it ran out on both screens), the paste-led page on a device that cannot scan, and a pasted
  code connecting on Go or by itself with Connect above the keyboard.
- [Read the pairing consent as short, plain bullets](./pairing-consent.md) —
  native release APK and PWA over a private stack: phone and browser control and
  view-only consent, plain copy, the words step saying its instruction once, and
  the spinner giving way to a check mark naming the computer, at 360dp/270dp font 1.3
  and 393/270 px, dark and light.
- [Pick which computer an agent runs on](./computers-sheet.md) —
  two-host lab (distinct UTS hostnames) driven on a release APK and the lab PWA:
  the Computers sheet lists the cloud row and each paired computer with its
  Online/Asleep/Offline state and the one in use; tapping another online computer
  switches it after a confirmation and the next prompt runs there, dark and light at 393/270 px.
- [Continue an agent on another computer](./continue-on-computer.md) —
  source-written note, read-only preview, same-kind start and prompt on a paired
  target, home-relative folder mapping, source remains open, native and installed-PWA proof.
- [Watch from a view-only browser that cannot type](./view-only-input.md) —
  a `--browser-view` PWA and a `--browser` PWA on one real Herdr lab host: the
  view one watches the pane but its typing, desktop and agent actions never
  reach the computer; the control one runs the command.
- [Read whole pairing and first-run words at large text](./word-wrapping.md) —
  unpaired pair title, comparison words, Connect button labels and the new agent
  screen's worktree hint: installed PWA at 393/270/208 dp, font 1.0/2.0, both
  themes, and native at 270 dp font 2.0; DOM ranges and screenshot OCR lead on
  words split across lines.
- [Tailscale is a fallback route, not a first-run gate](./tailscale-first-step.md) —
  the unpaired first screen's link-first card on a release APK (Play Store AVD)
  and the PWA: no gate stands in front of the connect link, "More ways & timing"
  names Tailscale among the fallback routes; use the Visual check's native
  and installed-PWA matrix at 393/270 dp, font 1.0/2.0, both themes.
- [Say which end to fix when pairing can't reach the computer over Tailscale](./pair-tailscale-unreachable.md) —
  a Tailscale-address offer whose first dial fails: one sentence naming this phone (no Tailscale
  address here) or the computer, on main and candidate release APKs at 393/270 dp both themes, a
  root-staged tun for the Tailscale-on case, the good case over this desktop's tailnet address, and the PWA.
- [Land on the first-run link-first shell](./first-run-browser-steps.md) —
  unpaired release APK and installed PWA: ready-link field → Connect →
  existing consent, active cloud-computer entry, unchanged native SSH login and
  expandable setup details; 393/270 dp, font 1.0/2.0, both themes and scrolled,
  plus a link-to-consent recording.
- [Start a cloud computer](./cloud-computer-onboarding.md) — native first-run
  entry → one checklist → Boat account-link screen; PWA explains setup is in the
  phone app. The first slice stops before machine creation; no second Boat claim.
- [Read the whole install command on the native first run](./first-run-install-command.md) —
  unpaired release APK at 393/270 dp, font 1.0/2.0, both themes: the command
  wraps inside the screen (uiautomator bounds, no sideways scroller) and Copy
  still hands over the one-line command.
- [Check the self-host](./selfhost-health.md) — relay `/health`, version
  identity, the owner-only hosts listing, and clean-container configure-only
  foreground startup with native tailnet pairing.
- [Keep a shell request's backgrounded child from outliving it](./host-shell-process-group.md) —
  real `machine.shell` over a fake-Herdr stack: prompt reply, backgrounded child
  reaped, and the host unit's memory and process count flat across the run.
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
- [Keep the mirror view up for a preview kind the client does not know](./unknown-preview-kind.md) —
  lab PWA over a throwaway unknown-kind injection: the header, help popup
  (general gestures) and toolbar (no device keys) all stay up, at 393/270 px.
- [See pinned spaces on the phone's Spaces list](./spaces-pinned.md) —
  native app on an emulator over a private stack: pin, themes, tablet width,
  plus guarded two-computer pin isolation and legacy migration.
- [Open the first agent with no notifications modal over it](./first-agent-no-modal.md) —
  native release app over a real-Herdr lab with no panes: fresh install,
  Home's Start an agent opens Claude Code and neither notifications modal
  appears in 30 s of 0.5 s screenshots; the Home card still asks.
- [Read the computer name in the Home header](./home-header-name.md) —
  native app over a named fake-Herdr stack: one line with an ellipsis, at
  270dp and font scale 2.0, light and dark.
- [Read a screen title in the sticky header](./sticky-header-title.md) —
  shared stack header on PWA and native: Accounts/Settings whole at 270 dp
  font 2.0; a longer title (Home's Connect a machine) wraps to two lines;
  390 dp font 1.0 unchanged.
- [Read a version difference as one quiet Home line](./home-version-line.md) —
  native release app and PWA over a fake-Herdr stack whose host reports 0.1.0:
  one secondary line at the foot, never the top slot, themes and 270dp/font 1.3.
- [Read plan limits on the Home card](./home-quota-row.md) —
  native app and PWA over a fake-Herdr stack with a stand-in Codex: window
  first, whole-item wrap, no ellipsis, at 270dp and font 1.3/2.0, both themes.
- [Read a space's agent count whole on Home](./home-spaces-count.md) —
  native app and PWA over a fake-Herdr stack: the count stays whole while the
  path chip ellipsizes, at 270 and 393 wide and font 1.3/2.0, both themes.
- [Add a second Claude account on iPhone and iPad](./accounts-ios.md) —
  Release simulator app over a fake-Herdr stack: the Added notice names
  accounts as the list does, light and dark, before/after one build.
- [OpenCode agents start on Muse Spark 1.3 Contributor](./opencode-go-default-model.md) —
  release APK on an emulator over a real lab host with an OpenCode Go
  sign-in: new agents open on the Go default model before/after one build,
  footer plus one real reply each; the account row and New agent read
  `Signed in` right after the sign-in, before and after an app restart.
- [See what runs your sessions from Settings](./settings-herdr-info.md) —
  Settings `Herdr` row and sheet with the `herdr agent list` command, Copy
  feedback, and the real-Herdr lab log proving the command lists the host's
  sessions.
- [Confirm the SSH host fingerprint before signing in](./ssh-host-fingerprint.md) —
  private SSH server and native release app: no authentication before explicit
  confirmation, cancellation, same-key reconnect and changed-key refusal.
- [Sign in over SSH with an Ed25519 key](./ssh-login-keys.md) —
  native release app against a container with generated Ed25519/RSA keys:
  real pairing consent, saved-credential reconnect, credential refusal and
  connected Direct SSH results at 393/270 dp, light/dark.
- [Read the connection route on the phone](./connection-route.md) —
  Settings > Connection names the route as `muxr setup` does: dev client on
  an emulator over a real lab host, themes and 270dp/font 1.3.
- [Pair a computer that dials out to the muxr relay](./dial-out-relay.md) —
  setup's `your muxr server` route with an enrollment, a computer with no
  inbound network (bwrap), phone pairs through a lab relay, agent answers.
- [Set up a computer in one screen](./setup-one-screen.md) — first-run
  `muxr` in a private tmux at 80 and 120 columns: Tailscale by default, Wi-Fi
  recommended for a plain computer, missing/signed-out Tailscale rechecked in
  place on a computer that is not plain,
  route and plan on step 2 of 3, one Enter applies.
- [Keep a terminal pane alive across a reconnect](./terminal-reconnect.md) —
  native app over a private stack: relay and host restarts under an
  open pane, last frame kept, recovery with no tap, plain words; a return
  from long enough background marks the pane stale in its first frame back
  (native and installed PWA), quick returns stay quiet.
- [Keep a shell usable after a crashed fullscreen agent](./terminal-shell-mode-reset.md) —
  wheel reports only while a program holds the pane; restore alt-screen/mouse
  once the program seen there is gone, or when the crash preceded the attach
  and the shell has no child left (a stopped one is left alone), so a swipe
  stays clean and the pane scrolls back.
- [Scroll a pane and come back with Latest](./terminal-latest.md) —
  native app over a real Herdr lab with long canned output: a finger drag moves
  the pane about as far as the finger in every kind, and Latest reaches the
  newest line, also while the agent is still printing and in a split width.
- [Type and send prompts in the web app without a crash](./web-prompt-typing.md) —
  web export on an Android emulator at 270 dp with Gboard: five sends to a
  real OpenCode agent, each reply shown, no React #185 screen.
- [Show a restored long draft whole in the agent's prompt field](./composer-restored-draft.md) —
  PWA and native over a fake-Herdr stack, main vs candidate: a 12-line draft
  restored on reopening the agent grows the field to six whole lines like a
  typed one; an empty field stays one row.
- [Keep the agent title and composer controls whole on a narrow PWA](./agent-narrow-chrome.md) —
  PWA main vs candidate at 135 px (270 dp, font 2.0) and 393 px, plus the
  native cell: the title stays whole and the rail wraps to field over
  `+` · microphone · Talk with nothing overlapping.
- [Keep an agent's grid tall enough when the keyboard opens](./terminal-keyboard-floor.md) —
  native app at 270 dp over a real Herdr lab: the keyboard leaves the pane at
  24 rows or more, OpenCode stays up and answers on OpenCode Go; the box follows
  the cursor so the reply shows with the keyboard up, and a drag pans to every
  row of a grid taller than the box (font 20).
- [Find an agent's changes from the terminal screen](./agent-changes-entry.md) —
  real Herdr lab and lab host, PWA main vs candidate: header `N files changed`
  pill only while the tree is dirty (live on idle, compact at 270 dp and font
  2.0), Pane actions › Changes, both opening the changes review.
- [Stay connected to a busy computer](./busy-computer.md) —
  homeLoad at 300 panes / 150 agents, then a frozen lab host on an emulator:
  busy card through the offline grace (up to 10 min for a link that was
  online), explanation only after it; host journals a stalled Herdr.
- [Select a terminal's text on iOS](./terminal-select-text-ios.md) —
  Select Text viewer: Select All, one-tap Copy and a read-only edit menu on
  iPhone and iPad simulators.
- [Keep terminal tab and notice chip labels inside their row](./terminal-tab-chip.md) —
  native app over a private stack: tab chip and notice chip (gesture hint,
  `Reconnecting…`) labels keep their descenders at Android font scale 2.0 and
  normal font scale is unchanged.
- [Keep the terminal key row and prompt field inside their rows at large font](./terminal-keyrow-font-scale.md) —
  native app over a private stack: every key stays reachable and the prompt
  placeholder stays in the rail at Android font scale 2.0; at normal scale the
  row fits the screen width.
- [Answer an agent's folder-trust question in one tap](./agent-trust-answers.md) —
  release APK and PWA over a guarded real-Herdr lab with a real, untrusted
  Claude Code: unnumbered choices as chips, timed trust step before/after, and
  Home and New agent sharing the last start folder.
- [Answer an OpenCode permission prompt in one tap](./opencode-permission-answers.md) —
  release APK and PWA over a guarded real-Herdr lab with a real OpenCode:
  Allow once / Allow always / Reject as chips at a cut-off phone row, each tap
  answering OpenCode's box whichever button is selected.
- [Read a Live preview with no output](./live-preview-empty.md) —
  native release app and PWA over a fake-Herdr stack whose pane reads empty:
  a calm placeholder and a plain line, themes and 270dp/360dp, live output
  unchanged.
- [Keep pairing and settings across an app upgrade](./upgrade-keeps-state.md) —
  main release APK paired with settings changed, `install -r` of the
  candidate, then pairing, theme and text size read back; fresh pair after.
- [Keep every New agent field clear of the sticky Start button](./new-agent-footer-clearance.md) —
  native release APK: at 270 dp largest font the scroll ends above the sticky
  Start footer, so the Folder field and every field stay fully visible above
  Start and a field tap never starts an agent.
- [Send a notification from a tool on the computer](./notify.md) —
  a loopback `POST /v1/notify` with the minted bearer token over a real relay
  and host: `202 {id, delivered_to}`, the count following each device's
  notification level, and the 400/401/405 refusals.
