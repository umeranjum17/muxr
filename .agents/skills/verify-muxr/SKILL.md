---
name: verify-muxr
description: Verify muxr's self-hosted relay/host, public CLI and phone screens the way a user drives them, from this pockit checkout and without touching the owner's installed muxr. Use before claiming a host, relay, Shared Artifacts, naming, retention, CLI or phone/PWA UI change works (every UI change runs the Visual check), when a check fails and you need a live instance to reproduce against, or when asked to run the verify-muxr flow.
license: Apache-2.0
---

# verify-muxr

Drives a private muxr stack (relay + host + naming loopback) plus the public
`muxr` CLI against disposable state, then captures proof. Everything below was
inspected from this repo's own launch code (`scripts/setup/presentation/up.mjs`,
`scripts/diagnostics/application/checkHostTakeover.mjs`, `scripts/cli.mjs`) and
uses only repo-shipped commands — no new harness.

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
- Cleanup kills only the exact PIDs this run started and removes only this
  run's scratch directory. Evidence is written elsewhere and must survive.

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
  node apps/relay/dist/main.js >"$RUN_ROOT/relay.log" 2>&1 &
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
MUXR_MODE=selfhost MUXR_DATA_DIR="$MUXR_HOME/host" \
  node apps/host/dist/main.js --fake >"$RUN_ROOT/host.log" 2>&1 &
HOST_PID=$!
for _ in $(seq 100); do grep -q 'link relay: online' "$RUN_ROOT/host.log" && break; sleep 0.1; done
grep -q 'link relay: online' "$RUN_ROOT/host.log" || { echo "host never came online:"; tail "$RUN_ROOT/host.log"; exit 1; }

# 4. Naming loopback (only `muxr preview status` needs it). Private fixed port;
#    the default 8797 belongs to the owner's real host.
MUXR_NAMING_PORT=38797 node scripts/naming/server.mjs >"$RUN_ROOT/naming.log" 2>&1 &
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

Define the run's stable evidence directory up front; cleanup never touches it:

```sh
EVIDENCE="/tmp/verify-muxr-evidence/$(date +%Y%m%d-%H%M%S)"; mkdir -p "$EVIDENCE"
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
it with `adb -s <serial> emu kill`, never the shared adb server. Per cell: set
size, density, `settings put system font_scale <f>` and
`cmd uimode night yes|no`, force-stop and relaunch (a stale layout survives a
font change), drive to the screen, then:

```sh
node .agents/skills/verify-muxr/features/visualCheck.mjs $SERIAL "$DIR" <name> [--ref $MAIN_DIR/<name>.xml]
# when the dump has scrollable="true": swipe up until it stops moving, then
node .agents/skills/verify-muxr/features/visualCheck.mjs $SERIAL "$DIR" <name>-scrolled --end [--ref $MAIN_DIR/<name>-scrolled.xml]
```

It saves the PNG and the uiautomator dump and prints `DEFECT …` lines for
what a machine can see (text under the status or navigation bar, text touching
the screen edge, overlapping elements, a covered control, a squashed image,
flat edge strips). `--ref` is the dump of the same cell from the main run
(on main itself, omit it; the line `image geometry not compared` says so).
Those are leads; the eye still judges every shot. Reset with
`wm size reset; wm density reset; settings put system font_scale 1.0`.

PWA: serve the export with `scripts/diagnostics/application/serveWebExport.mjs`
on a free port (it prints the port you pass, so pass a real one, never 0), and open it in Chromium on a
task-owned Xvfb display with its own `--user-data-dir`,
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
`scrollHeight` and shoot `-scrolled`. After each shot run the DOM leads:

```sh
chrome-devtools-axi eval "$(node .agents/skills/verify-muxr/features/visualCheck.mjs pwa)"
```

They report off-screen text and images, clipped text, text spilling out of
its button, a control covered by another element, and a stretched image;
`clean` is only a lead, the shot still gets looked at.

Self-tests (run once per change to the checks, not per cell). They prove the
checks fire on a squashed image and a black strip and stay quiet on a cover
crop and a uniform background; they need ImageMagick and `chromium`:

```sh
node .agents/skills/verify-muxr/features/visualCheck.mjs selftest      # native: avatar geometry and edge strip
node .agents/skills/verify-muxr/features/visualCheck.mjs pwa-selftest  # PWA: squashed img and background vs cover
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
  position; under the gesture or navigation bar once the screen can scroll no
  further (content passing under the translucent gesture bar mid-scroll is
  fine); under the keyboard, a toast, or another element.
- **Off-screen or unreachable** — any part beyond the screen edge, or a
  control no scroll brings fully into view.
- **Blank or black strip** — a flat band along an edge or between sections
  that the mock does not have (e.g. a black left strip).
- **Button or field hidden under a sticky element** — a header, footer,
  composer, tab bar or floating button covering a control at any scroll
  position, including the end.

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
retrying so broken attempts strand no processes or ports.
