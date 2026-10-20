---
name: verify-pockit
description: Verify muxr's self-hosted relay/host, public CLI and phone screens the way a user drives them, from this pockit checkout and without touching the owner's installed muxr. Proof runs through done-done (sealed run, evidence, judge, receipt). Use before claiming a host, relay, Shared Artifacts, naming, retention, CLI or phone/PWA/iOS Simulator UI change works (every UI change runs the Visual check), when a check fails and you need a live instance to reproduce against, or when asked to run the verify-pockit flow.
license: Apache-2.0
---

# verify-pockit

Drives a private muxr stack (relay + host + naming loopback) plus the public
`muxr` CLI against disposable state, then captures proof. Everything below was
inspected from this repo's own launch code (`scripts/setup/presentation/up.mjs`,
`scripts/diagnostics/application/checkHostTakeover.mjs`, `scripts/cli.mjs`) and
uses only repo-shipped commands — no new harness.

## Proof through done-done

Every proof is a done-done run. `.done-done.yaml` owns the journeys:

- `fast`: `yarn run check:fast` (the pull-request lane; the fast default).
- `suite`: `yarn run check` (the full suite, 30 min timeout).

Prerequisites per checkout: `yarn install --frozen-lockfile --non-interactive && yarn build`.

```sh
done-done run fast                      # seals a run, records its evidence folder
done-done check --outcome "<what a user can now do>" <files it recorded>
done-done verify fast --outcome "<claim>"   # drives the journey, judges captures, records a receipt
done-done receipt --verify <head>       # read-only: verify the recorded receipt
```

- Run evidence lives under `~/.done-done/evidence/pockit/`, never in the repo.
- A PR's `## Checks` block names this skill for `proof:` and the run's files for `evidence:`.
- After a drive, `done-done maintain` reports drift between this skill and the source; fix the skill, not the run.
- Headless smoke entry (done-done scaffold): `node perf/fake-herdr/stack.smoke.mjs` runs the relay and host over a fake Herdr with a scripted phone client; success is exit 0 and the final line `fake-herdr stack smoke ok`. It uses `MUXR_RELAY_PORT=0` and tears down what it starts. The per-feature entries in `features/` cite it.

## Isolation contract (read first)

- Run every command with a task-owned `MUXR_HOME` (never `~/.muxr`) and a
  task-owned relay data dir. Never read, grep, or print `~/.muxr/` or any
  credential file: pairing grants and machine keys live there.
- Strip ambient muxr env before launching, so a lab process can never dial the
  owner's real relay: `unset MUXR_RELAY_TOKEN MUXR_RELAY_URL MUXR_MACHINE_ID MUXR_RELAY_AUTH MUXR_DATA_DIR MUXR_NAMING_PORT`.
- Relay listens on `MUXR_RELAY_PORT=0` (kernel-picked). The bound port is read
  from **our child's own stdout line** `relay listening on wss://…:<port>` —
  that line cannot come from any stranger's process, unlike a health probe.
  This is the repo's own rule (`scripts/diagnostics/application/waitForRelay.mjs`).
- The host runs with `--fake` (the repo's fake development session source, same
  as `yarn host`). It therefore never attaches to a real Herdr session.
- Herdr features that need a pane (`share`, `name`, `preview status`) run inside
  a Herdr pane of a **non-default** session you own. Never touch the `default`
  session, never run `herdr server stop` or any server-wide operation.
- Never touch ports 8792–8793 or any already-listening port; pick your own
  naming port (below) and port 0 for the relay.
- Cleanup kills only the exact PIDs this run started, waits for them to exit,
  and removes only this run's scratch directory. Evidence is written elsewhere
  and must survive.
- Every long-lived process started by a proof (Metro, test/lab servers,
  emulators, adb servers or watchers) must send stdin from `/dev/null` and
  stdout/stderr to a task log (`>"$RUN_ROOT/<name>.log" 2>&1 </dev/null &`),
  record its PID, and be stopped and awaited in cleanup, including failure
  paths. Never leave a process attached to the agent's stdout pipe.

## Launch

From the repo root, after `yarn install && yarn build` (needs
`apps/relay/dist/main.js`, `apps/host/dist/main.js`, and
`apps/host/dist/agent/infrastructure/artifactRetention.js` on disk):

```sh
RUN_ROOT="$(mktemp -d /tmp/muxr-verify-XXXXXX)"          # scratch: dies in cleanup
export MUXR_HOME="$RUN_ROOT/muxr-home"
mkdir -p "$MUXR_HOME"
unset MUXR_RELAY_TOKEN MUXR_RELAY_URL MUXR_MACHINE_ID MUXR_RELAY_AUTH MUXR_DATA_DIR MUXR_NAMING_PORT
export MUXR_RELAY_MDNS=0 MUXR_NO_SERVICE_COMMANDS=1

# 1. Relay on a kernel-picked port; the stdout line below is the ownership proof.
MUXR_RELAY_PORT=0 MUXR_RELAY_DATA_DIR="$RUN_ROOT/relay" \
  node apps/relay/dist/main.js >"$RUN_ROOT/relay.log" 2>&1 </dev/null &
RELAY_PID=$!
RELAY_PORT=""
for _ in $(seq 100); do
  RELAY_PORT="$(sed -n 's/^relay listening on wss\?:\/\/[^:]*:\([0-9][0-9]*\)\s*$/\1/p' "$RUN_ROOT/relay.log" | head -n1)"
  [ -n "$RELAY_PORT" ] && break
  kill -0 "$RELAY_PID" 2>/dev/null || { echo "relay died:"; tail "$RUN_ROOT/relay.log"; exit 1; }
  sleep 0.1
done
[ -n "$RELAY_PORT" ] || { echo "relay never reported its port"; exit 1; }

# 2. selfhost.json pointing the host at OUR relay (mirrors checkHostTakeover.mjs).
RUN_ROOT="$RUN_ROOT" RELAY_PORT="$RELAY_PORT" node --input-type=module -e '
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { machineIdentity } from "./scripts/setup/index.mjs";
const { RUN_ROOT, RELAY_PORT } = process.env;
const home = join(RUN_ROOT, "muxr-home");
mkdirSync(home, { recursive: true });
const mintSecret = JSON.parse(readFileSync(join(RUN_ROOT, "relay", "mint-secret"), "utf8"));
const machine = { ...machineIdentity(undefined), name: "Verify machine" };
writeFileSync(join(home, "selfhost.json"), JSON.stringify({ version: 1, machine,
  relayPort: Number(RELAY_PORT), relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
  relayLocation: "local", relayRole: "single-machine", connectionMode: "lan",
  webEnabled: false, mintSecret }) + "\n", { mode: 0o600 });
'
OWNER_SECRET="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")))' "$RUN_ROOT/relay/mint-secret")"

# 3. Host with the fake session source. Ready when its own log says online.
#    MUXR_HOME is required: a --fake or source-build host refuses the default ~/.muxr.
MUXR_HOME="$MUXR_HOME" MUXR_MODE=selfhost MUXR_DATA_DIR="$MUXR_HOME/host" \
  node apps/host/dist/main.js --fake >"$RUN_ROOT/host.log" 2>&1 </dev/null &
HOST_PID=$!
for _ in $(seq 100); do grep -q 'link relay: online' "$RUN_ROOT/host.log" && break; sleep 0.1; done
grep -q 'link relay: online' "$RUN_ROOT/host.log" || { echo "host never came online:"; tail "$RUN_ROOT/host.log"; exit 1; }

# 4. Naming loopback (only `muxr preview status` needs it). Private fixed port;
#    the default 8797 belongs to the owner's real host.
MUXR_NAMING_PORT=38797 node scripts/naming/server.mjs >"$RUN_ROOT/naming.log" 2>&1 </dev/null &
NAMING_PID=$!
```

The public CLI for every drive is `node scripts/cli.mjs <command> …` from the
repo root (the tracked source of the installed `muxr` binary), always with the
same `MUXR_HOME`.

## Doctor (read-only)

Run this before driving whenever anything looks off:

```sh
node scripts/cli.mjs --version                                  # CLI identity
node -p "require('./package.json').version"                     # must equal muxrVersion below
curl -fsS "http://127.0.0.1:$RELAY_PORT/health"                 # {"ok":true,"muxrVersion":"…","linkProtocol":1,…}
curl -fsS -H "authorization: Bearer $OWNER_SECRET" \
  "http://127.0.0.1:$RELAY_PORT/relay/v1/hosts"                 # exactly one online host: ours
grep -c 'link relay: online' "$RUN_ROOT/host.log"               # 1
```

Worth driving means: `/health` says `ok`, `muxrVersion` equals the repo version,
the hosts list shows our one host online, and `$RELAY_PORT` came from our
child's stdout (Launch step 1), not from a port scan.

## Drive

Read `features/README.md` first, then the feature file for the behavior you are
verifying. Each file lists exact commands, observable results, and the durable
side effect that proves the feature. Prefer running CLI commands inside a real
Herdr pane you own (so `HERDR_PANE_ID` is set the way users get it) over
synthesizing flags.

## Evidence

Inside a `done-done run`, `$DONE_DONE_EVIDENCE_ROOT` is the stable evidence
folder and the judge reads only what is saved there. Outside one, define the
evidence directory up front; cleanup never touches it:

```sh
EVIDENCE="$HOME/.done-done/evidence/pockit/manual-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$EVIDENCE"
```

Capture, per proof, into `$EVIDENCE` (outside `RUN_ROOT`):

- the command transcript (command line, stdout, stderr, exit code) —
  `… 2>&1 | tee "$EVIDENCE/NN-command.log"; echo "exit=$?" >> "$EVIDENCE/NN-command.log"`,
- the durable side effect, read back through a second user-facing view
  (directory listing, `cmp` against the source bytes, a read-only CLI view),
- environment identity: `node scripts/cli.mjs --version`, the relay `/health`
  body, the git HEAD (`git rev-parse HEAD`), and the owned relay port,
- for a failure-path proof, the exact failing input and its stderr.

Standards: exercise the real user path (public CLI flags, running services) —
never internal setters, test-only endpoints, or mocks standing in for the
feature; the action and the resulting state, not just the final screen; the
side effect verified where it is stored, not only where it is displayed.

## Review evidence standard

Fleet rule: every user-visible change is captured with each changed screen
before/after, in every theme (dark and light) and form factor (phone and
desktop width) the app has, plus one motion recording of each changed
interaction — into the stable `$EVIDENCE` folder above. Applied to this skill:

- Before/after: for each mutation proof, capture the read-only view before
  the command as well as after (e.g. list the artifact timeline, run
  `muxr share`, list again and `cmp` the bytes). A command transcript alone
  is not a complete proof. Name the transcript and state files in the PR.
- Skipped — no themed surfaces: the relay, host, and CLI this skill drives
  render no dark/light UI, so there is nothing to capture per theme.
- Phone app and PWA screens: the **Visual check** below is required for every
  UI change. Terminal dimensions do affect pairing QR admission:
  `features/pairing-qr.md` captures normal/narrow grids and an isolated Herdr
  terminal before/after.
- Skipped — no motion: CLI output is text with no transitions or gestures,
  so there is no interaction to motion-record; the command transcript
  (`NN-command.log` with stdout, stderr, and exit code) is the equivalent
  capture.

## Visual check (required for every UI change)

Any change a user can see on the phone (a screen, component, style, theme,
layout or copy under `apps/mobile/`) runs this check on `origin/main` and on
the candidate before the PR. **Any defect below fails the check.** A change
with no UI writes `visual check: n/a (no UI change)`.

### Capture matrix

Per changed screen, on main and on the candidate:

- surface: **native Android** (release APK from `perf/buildPrApk.mjs` on a
  task-owned emulator) and **installed PWA** (the web export in a standalone
  `--app=` Chromium window where `matchMedia('(display-mode: standalone)')`
  is true, as in `features/pwa-splash.md`);
- width: **270 dp** (`wm size 1080x2376; wm density 640`) and **393 dp**
  (`wm density 440`);
- system font: **1.0** and **2.0** (Android's largest);
- theme: **light** and **dark**;
- plus the **scrolled** state (scrolled to the end) whenever the screen scrolls.

Name each shot `<screen>-<width>-<font>-<theme>[-scrolled].png`, e.g.
`firstrun-tailscale-270-2.0-dark-scrolled.png`, under
`$EVIDENCE/visual/<native|pwa>/<main|candidate>/`.

Native: hold the shared emulator lock for the whole journey as
`flock -o -w <s> /tmp/fm-muxr-emulator.lock timeout 1800 <journey>` (`-o`, so
an adb server started inside never keeps it; at most 30 min), start the
emulator through `fm-mem-gate.sh`, name `-s <serial>` on every adb call, kill
it with `adb -s <serial> emu kill`, never the shared adb server. The mem gate
and the emulator lock are this fleet's host tools; where they are missing,
start the emulator directly and skip the lock. Per cell: set
size, density, `settings put system font_scale <f>` and
`cmd uimode night yes|no`, force-stop and relaunch (a stale layout survives a
font change), drive to the screen, then:

```sh
node .agents/skills/verify-pockit/features/visualCheck.mjs $SERIAL "$DIR" <name> [--ref $MAIN_DIR/<name>.xml]
# when the dump has scrollable="true": swipe up until it stops moving, then
node .agents/skills/verify-pockit/features/visualCheck.mjs $SERIAL "$DIR" <name>-scrolled --end [--ref $MAIN_DIR/<name>-scrolled.xml]
```

It saves the PNG and the uiautomator dump and prints `DEFECT …` lines for
what a machine can see (text under the status bar; text or a button box under
the navigation bar: at rest, any text or button box whose bottom edge sits more
than 4px into the bar, inside a scroller or not; with `--end`, any of it still
under the bar; text touching the screen edge, or a button box past it even when
its text fits, unless the node sits in a horizontal scroller that swipe
reaches; clipped text (an ellipsis, including one Android paints while the dump keeps the whole label, read by OCR; running past its parent, or squeezed to a sliver); a word split
across lines (screenshot OCR reconciled against the full accessibility label,
a lead since OCR can miss or misread); overlapping elements; an unlabelled
image off-screen or painted over a control; a covered control; a squashed
image or an image with no reference twin; flat edge strips; a text or button box below the viewport on a screen that cannot scroll,
with or without the bar). Any DEFECT line fails the cell (exit 1). `--end`
runs on every screen that scrolls, as well as the at-rest shot: its
scrolled-to-end shot must show the content clear of the bar.
`--ref` is the dump of the same cell from the main run (on main itself, omit
it; the line `image geometry not compared` says so). The eye still judges every
shot too. A DEFECT that is a false positive is overridden only by a named line
in the PR's `## Checks` block: `false lead: <cell> <lead>: <why>`. Reset with
`wm size reset; wm density reset; settings put system font_scale 1.0`.

Typing a prompt into the app: text reaches the agent exactly as typed, on
every surface. `adb shell input text` maps only `%s` to a space — every other
byte lands verbatim, so URL-encoded text like `Reply%20with%20exactly:%20x`
reaches the agent with literal `%20` in it (that readiness defect was the
harness, not the product). Write spaces as `%s`
(`adb shell input text 'Reply%swith%sexactly:%sx'`), or type longer text with
`scripts/diagnostics/application/checkFocusedSecretTyping.mjs --serial <s>
--text 'Reply with exactly: x'` (one char per call with a readback). Over the
PWA, type through real key events (`chrome-devtools-axi type`), never a
dom-value paste. Never compensate in product code: a literal `%20` a person
types must reach the agent verbatim, so no surface may decode prompt text.

PWA: serve the export with `scripts/diagnostics/application/serveWebExport.mjs`
on a free port (it prints the port you pass, so pass a real one, never 0), and open it in Chromium on a
display from `scripts/diagnostics/application/withPrivateXvfb.sh` (never a bare `Xvfb`) with its own `--user-data-dir`,
`--remote-debugging-port`, `--hide-scrollbars` (a desktop scrollbar draws a
grey strip that is not the app) and `--app=<origin>`; point
chrome-devtools-axi at it with `CHROME_DEVTOOLS_AXI_BROWSER_URL`.
react-native-web pins `fontScale` to 1 and an installed PWA takes the system
text size as page zoom, so font F at width W x H is a viewport of W/F x H/F CSS
px (393 x 864 and 270 x 594 at 1.0; 196 x 432 and 135 x 297 at 2.0). Per cell:
`emulate --viewport "<W/F>x<H/F>x<2F>,mobile,touch" --color-scheme <theme>`,
reload, wait until `document.body.innerText` is non-empty (a shot taken
earlier is a blank page, not a pass), `emulate` again (a reload drops it),
`screenshot`, then set every scrollable element's `scrollTop` to its
`scrollHeight` and shoot `-scrolled`. After each shot, run the driver on the
same page; it runs the DOM leads itself and exits 1 on any DEFECT:

```sh
node .agents/skills/verify-pockit/features/visualCheck.mjs pwa-check "$DIR/<name>.png" <name>
```

They report off-screen text and images (a part inside a horizontal overflow
scroller is excused, as on native, since swipe reaches it), clipped text
(including text cut by an overflow-hidden ancestor), a word split across lines
(from a word's DOM range fragments), text spilling out of its
button, text painted over by another text or an image, a control covered by
another element (a point scrolled out of its scroller is not judged), and a
stretched image; the driver adds a blank-strip read of
the screenshot itself. Known blind spot: text under a `pointer-events: none`
image or background is not flagged, because the hit test skips such layers.
Paste the driver output into the PR's `## Checks` block. Any line other than
`clean` is a DEFECT and fails the cell, with the same `false lead:` override
as native. A `blank page` line means the shot was taken before the app drew:
retake the shot; it fails the cell like any other DEFECT.

Self-tests (run once per change to the checks, not per cell). One flow per
page: native (the pair-screen defect under the bar, a squashed avatar and a
button below the screen; a clean pair entry that must stay silent, with a
horizontal carousel past the edge; a blank strip) and PWA (a fixture page with
squashed images, text over text and over an image, overflow clipping, an
off-screen chip inside and outside a scroller; the `pwa-check` driver's exit
codes on a DEFECT, a clean page, a page with no eval result, and a strip
shot). Both also check split Securely/Tailscale/Connect against intact
whole-word wrapping. Native OCR is a lead, not a guarantee: a misread or missed
fragment can hide a split. They need ImageMagick, Tesseract and `chromium`:

```sh
node .agents/skills/verify-pockit/features/visualCheck.mjs selftest      # native: the pair-screen flow
node .agents/skills/verify-pockit/features/visualCheck.mjs pwa-selftest  # PWA: the fixture page and the driver
```

Each prints `PASS`/`FAIL` per case and exits non-zero on any `FAIL`.

### Defects (each fails the check)

- **Stretched or squashed image** — a filled image's drawn box differs in
  aspect by more than 2% from its source: on the PWA, the natural size of an
  `img` or background image drawn with `object-fit: fill` or two explicit
  `background-size` values (cover and contain crops are not defects); on
  native, the same image node's bounds in the `--ref` dump. A round avatar
  drawn as an oval, a logo wider or taller than the mock.
- **Text clipped, cut or truncated mid-word** — glyphs cut at a box edge
  (descenders, half a last line), a word broken with no hyphen, a line that
  starts with punctuation (`, signed`), text running past the screen edge or
  out of its button, or an ellipsis where the mock shows the whole text
  (an ellipsis the feature file names as intended is not a defect).
- **Overlap** — text or a control under the status bar or clock at any scroll
  position; under the gesture or navigation bar: any text or leaf button box
  more than 4px into it at rest (a clickable box over a quarter of the screen
  height is judged by its children instead), and any content still under it
  once scrolled to the end (`--end`); content passing under the translucent bar
  mid-scroll is fine; under the keyboard, a toast, or another element; text
  painted over by another text or an image; an image painted over a control.
- **Off-screen or unreachable** — any part beyond the screen edge (a button
  box as well as its text; a labelled or unlabelled image), except a part
  inside a horizontal scroller, which swipe reaches, on native and PWA alike;
  or a control no scroll brings fully into view.
- **Blank or black strip** — a flat band along an edge or between sections
  that the mock does not have (e.g. a black left strip), on native and PWA
  screenshots alike.
- **Button or field hidden under a sticky element** — a header, footer,
  composer, tab bar or floating button covering a control at any scroll
  position, including the end.

Each defect class above has a machine lead, not a guarantee; the eye still
judges every shot too, against the mock or the main shot of the same cell.

### Compare and report

Put every candidate shot side by side with the approved mock (from the brief
or issue) or, with no mock, the main shot of the same cell:
`magick main.png candidate.png [mock.png] +append $EVIDENCE/visual/compare/<name>.png`,
and open each one. Any defect the mock does not have fails; with no mock, any
defect not already on main fails, and defects already on main are listed as
`pre-existing`, never hidden. The PR's `## Checks` block lists the matrix and
the verdict:

```
visual matrix: native+pwa x 270/393 dp x font 1.0/2.0 x light/dark (+scrolled): <screens>; shots in <dir>
visual check: PASS            (or: visual check: FAIL: <shot>: <defect>; …)
```

### Design check (not yet part of this check)

Not yet part of this check; a later step will be wired in here.
Do not report a design check as run until it is.

## iOS Simulator path (Mac)

Proves a Release iOS build on a simulator this task booted, paired to a private
host, with Home captured dark and light. The Mac is shared: it takes one device
at a time through the Mac slot, and it has about 10 GiB free for a Release build.

- **Preconditions.** `fm-mac-slot.sh status` shows `lock: free`, `boot: none`,
  `iOS booted: 0`. A booted simulator this task did not boot = blocked, naming
  it. Only use a simulator with a creation receipt in the slot's
  `.ios-devices.json` (`0A257D0B-1E70-4752-94A7-AC0C78CEAA11`, `fm-iPhone 17 Pro`).
  Check disk first: `ssh <mac-user>@<mac-ip> 'df -h ~'`.
- **Run and slot.** The iOS path does not run Launch. Start its own scratch:
  `RUN_ROOT="$(mktemp -d /tmp/muxr-verify-XXXXXX)"`, and define `EVIDENCE` as in Evidence above.
  Set `RUN_ID` to this run's unique id. In the Mac shell set
  `MAC_RUN="$HOME/fm-verify-pockit-ios1/$RUN_ID"`.
  `SLOT=~/firstmate/data/fm-mac-slot1/fm-mac-slot.sh`. Run
  `if "$SLOT" claim; then if ! touch "$RUN_ROOT/slot-claimed"; then "$SLOT" release; exit 1; fi; else exit 1; fi`,
  then run `$SLOT boot ios <UDID>`. If recording the successful claim fails, release
  it immediately and end the drive; a failed claim ends without Mac-side work, stop, or release.
- **Build.** Mac scratch is the per-run `$MAC_RUN`. Only after the local marker exists,
  create it and `touch "$MAC_RUN/slot-claimed"` in the same SSH call, then copy the archive and extract into `$MAC_RUN/<sha>`. Linux:
  `git archive --format=tar <sha> -o "$RUN_ROOT/src.tar"`. Mac, through
  `fm-mem-gate.sh` and backgrounded, from that folder with
  `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8` (pod install fails on the ssh default
  locale): `yarn install --frozen-lockfile --non-interactive`, `yarn build`,
  `node scripts/diagnostics/application/syncIosFramework.mjs --verify`,
  `(cd apps/mobile/ios && pod install)`, then, with `set -o pipefail` first so
  the status is xcodebuild's and not tee's, `xcodebuild -workspace
  apps/mobile/ios/muxr.xcworkspace -scheme muxr -configuration Release -sdk
  iphonesimulator -derivedDataPath $MAC_RUN/dd
  CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=NO
  DEBUG_INFORMATION_FORMAT=dwarf build 2>&1 | tee $MAC_RUN/build.log`
  (Cleanup copies this log out). The app is
  `$MAC_RUN/dd/Build/Products/Release-iphonesimulator/muxr.app`
  (`com.trymuxr.app`); `xcrun simctl install <UDID> <app>`.
- **Host.** Before any process starts, in this shell:
  `unset MUXR_RELAY_TOKEN MUXR_RELAY_URL MUXR_MACHINE_ID MUXR_RELAY_AUTH MUXR_DATA_DIR MUXR_NAMING_PORT`
  and `export MUXR_RELAY_MDNS=0 MUXR_NO_SERVICE_COMMANDS=1`. Set the home
  explicitly: `export MUXR_HOME="$RUN_ROOT/muxr-home"` and `mkdir -p "$MUXR_HOME"`.
  On this path run one relay and one host of its own under that home; do not start
  Launch's loopback relay or its `--fake` host.
  From the repo root, start the relay on the tailnet address:
  `MUXR_RELAY_PORT=0 MUXR_RELAY_HOST=<tailnet ip> MUXR_RELAY_DATA_DIR="$RUN_ROOT/relay" MUXR_RELAY_MDNS=0 node apps/relay/dist/main.js >"$RUN_ROOT/ios-relay.log" 2>&1 </dev/null &`,
  then `IOS_RELAY_PID=$!`. Read its port from the `relay listening on ws://…:<port>` line in `ios-relay.log`
  with the same `sed` and 100-try loop as Launch step 1, then check `/health` ok. Write `$MUXR_HOME/selfhost.json`
  with the fields Launch step 2 writes, but `relayUrl` `ws://<tailnet ip>:<port>`. Create the tailnet state with the product command, run in this throwaway `MUXR_HOME` (never the captain's home): `muxr self-host --configure-only --advertise ws://<tailnet-address>:<port> --port <port>` (see `features/selfhost-health.md`; `configureSelfHost.mjs` sets `bindHost` from the tailnet address). Do not hand-set `bindHost`,
  and its mint secret from `$RUN_ROOT/relay/mint-secret`. Before any lab command,
  isolate ambient stores: `export HOME="$RUN_ROOT/home"`; then
  `mkdir -p "$HOME" "$HOME/.config" "$HOME/.local/share" "$HOME/.cache" "$HOME/.local/state" "$MUXR_HOME"`
  and export `XDG_CONFIG_HOME="$HOME/.config"
  XDG_DATA_HOME="$HOME/.local/share" XDG_CACHE_HOME="$HOME/.cache"
  XDG_STATE_HOME="$HOME/.local/state"`. Herdr: provision a lab
  session with `fm-herdr-lab.sh name` and `provision`, with
  `FM_HERDR_LAB_STATE_DIR` in scratch (mode 700). Before launching the host,
  `unset HERDR_SOCKET_PATH`. Run the host
  without `--fake` from the repo root with task-owned HOME/XDG stores:
  `MUXR_MODE=selfhost MUXR_DATA_DIR="$MUXR_HOME/host" MUXR_HOME="$MUXR_HOME" HERDR_SESSION=<lab session> node apps/host/dist/main.js >"$RUN_ROOT/ios-host.log" 2>&1 </dev/null &`,
  then `IOS_HOST_PID=$!`. Wait for `link relay: online` in
  `ios-host.log`.
- **Pair.** Only after this run's `slot-claimed` marker exists. Words handoff:
  the host offers, the phone shows two words, and the host grants only when the
  agent delivers the same two words. Never approve without them. From a
  task-owned kit directory, with the same home and lab
  session, run in the background as `PAIR_PID=$!`:
  `REPO="$PWD"`, `mkdir -p "$RUN_ROOT/kit"`, `cd "$RUN_ROOT/kit"`, then
  `MUXR_HOME="$RUN_ROOT/muxr-home" HERDR_SESSION=<lab session> node "$REPO/scripts/cli.mjs" pair --handoff >"$RUN_ROOT/pair.log" 2>&1 </dev/null &`
  with `PAIR_PID=$!` on its own line, so `$!` is node and not a subshell. The offer lands in
  `$RUN_ROOT/kit/.byokit/outbox/muxr-pair-*.json`, and its `wordsFile` names the
  inbox file. Once the offer exists, hand the link to the Mac as a file: it is
  never on an ssh command line, never printed, and never teed into evidence.
  ```sh
  OFFER="$(ls "$RUN_ROOT"/kit/.byokit/outbox/muxr-pair-*.json)"
  node -e 'const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write("muxr://pair#" + o.offer)' "$OFFER" \
    | ssh <mac-user>@<mac-ip> "umask 077; mkdir -p ~/fm-verify-pockit-ios1/<RUN_ID>; cat > ~/fm-verify-pockit-ios1/<RUN_ID>/pair-link.txt"
  ssh <mac-user>@<mac-ip> 'xcrun simctl openurl <UDID> "$(cat ~/fm-verify-pockit-ios1/<RUN_ID>/pair-link.txt)"; st=$?; rm -f -- ~/fm-verify-pockit-ios1/<RUN_ID>/pair-link.txt; exit $st' && echo "openurl sent"
  ```
  Offers expire in about two minutes, so send it at once. Tap Pair with
  `axe tap -x <pt> -y <pt>` on the Mac; points are the screenshot pixels divided
  by 3. Find the button with `$SLOT ios-shot` or `axe describe-ui`. When the phone
  shows its two words, read them from `$SLOT ios-shot "$EVIDENCE/ios-pair-words.png"`
  and write exactly those words to `$RUN_ROOT/kit/words.tmp` with `umask 077`, then
  `mv` it to `$RUN_ROOT/kit/.byokit/inbox/<wordsFile>`, so the host never reads a
  partial file. Then `wait "$PAIR_PID"` and require exit 0. Wrong words refuse
  pairing. Handoff refuses once a phone is paired, so use a fresh lab host.
- **Capture.** Run `ssh <mac-user>@<mac-ip> 'xcrun simctl ui <UDID> appearance dark'`, wait a few
  seconds, then `$SLOT ios-shot "$EVIDENCE/ios-home-dark.png"`. Run
  `ssh <mac-user>@<mac-ip> 'xcrun simctl ui <UDID> appearance light'`, wait a few
  seconds, then `$SLOT ios-shot "$EVIDENCE/ios-home-light.png"`. Home shows the paired machine as
  `connected`. Open every shot before reporting.
- **Cleanup.** On every iOS exit, run each line independently; do not let an earlier failure skip a later line:
  ```sh
  cleanup_failed=0
  for pid in "${IOS_HOST_PID:-}" "${IOS_RELAY_PID:-}" "${PAIR_PID:-}"; do
    [ -z "$pid" ] || { kill "$pid" 2>/dev/null || cleanup_failed=1; wait "$pid" 2>/dev/null || cleanup_failed=1; }
  done
  fm-herdr-lab.sh teardown <session> || cleanup_failed=1
  if [ -e "$RUN_ROOT/slot-claimed" ]; then scp <mac-user>@<mac-ip>:~/fm-verify-pockit-ios1/<RUN_ID>/build.log "$EVIDENCE/ios-build.log" || cleanup_failed=1; fi
  if [ -e "$RUN_ROOT/slot-claimed" ]; then ssh <mac-user>@<mac-ip> 'if xcrun simctl list devices booted | grep -Fq "(<UDID>)"; then xcrun simctl shutdown <UDID> || exit; fi; if xcrun simctl list devices booted | grep -Fq "(<UDID>)"; then echo "<UDID> remains booted" >&2; exit 1; fi; rm -rf -- ~/fm-verify-pockit-ios1/<RUN_ID>' || cleanup_failed=1; fi
  if [ -e "$RUN_ROOT/slot-claimed" ]; then "$SLOT" release || cleanup_failed=1; fi
  if ! "$SLOT" status >"$EVIDENCE/ios-slot-final-status.log"; then echo "slot status failed"; cleanup_failed=1; fi
  if ! grep -q '^lock: free$' "$EVIDENCE/ios-slot-final-status.log"; then echo "slot lock is not free"; cleanup_failed=1; fi
  if ! grep -q '^iOS booted: 0$' "$EVIDENCE/ios-slot-final-status.log"; then echo "booted simulator remains"; cleanup_failed=1; fi
  [ "$cleanup_failed" -eq 0 ] || exit 1
  ```
  Each cleanup line is a separate step and must be attempted even if an earlier
  one fails. The stop targets `<UDID>` only after an exact booted-device match.
  Final status must verify `lock: free` and `iOS booted: 0`; report any failed
  line.

The Android and PWA Visual check above does not cover these shots: they prove a
simulator Home, not the matrix.

## Cleanup

```sh
kill "$NAMING_PID" "$HOST_PID" "$RELAY_PID" 2>/dev/null    # exact PIDs this run started
wait "$NAMING_PID" "$HOST_PID" "$RELAY_PID" 2>/dev/null
rm -rf "$RUN_ROOT"                                         # scratch only
ls "$EVIDENCE"                                             # proof must still exist
```

Close any Herdr workspaces/panes this run created, then stop and delete only
the non-default session you created. Never kill by process name. Never remove
the evidence directory. If a drive failed midway, run this same cleanup before
retrying so broken attempts strand no processes or ports. On an iOS drive, run the
iOS Cleanup bullet as well, before removing `$RUN_ROOT` so its claim marker remains available.
