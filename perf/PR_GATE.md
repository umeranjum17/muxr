# Local emulator PR smoke

This is a bounded feature and performance-pathology gate for review, alongside
`releaseGate.mjs`. It reuses the real relay/host/fake-Herdr stack, real E2EE
pairing, existing Maestro navigation, and OS samplers. It does not replace the
release gesture/latency gate or a physical-device run.

Run long builds and gates in a dedicated herdr shell pane. Use an otherwise idle,
dedicated emulator: the gate intentionally uninstalls `com.trymuxr.app` and
installs its own test-signed release APK. No personal app state is retained.
The gate pins all adb/Maestro commands to `--serial`, accepts emulator serials
only, and takes an atomic per-emulator lock. Check other panes/processes before
using it; the lock cannot detect tools which do not cooperate. A stale lock at
`/tmp/muxr-pr-gate-<serial>.lock/owner.json` must be inspected before removal.

```bash
# In a dedicated shell pane, cd to the exact reviewed source checkout first.
# Node 22.13+, Java 21, Android SDK/NDK, Python 3, private yarn dependencies,
# and Maestro 2.7.0 (via mise, or MAESTRO_BIN=/absolute/path/to/maestro).
git rev-parse HEAD
git status --short
# Keep this checkout frozen until build and gate finish.
node perf/buildPrApk.mjs /tmp/pr-apk

# Save review artifacts directly into the pane's watched directory.
mkdir -p "$HOME/.pocketherdr/attachments/pane/$HERDR_PANE_ID" \
  "$HOME/.muxr/attachments/pane/$HERDR_PANE_ID"
EVIDENCE_ROOT=$(mktemp -d "$HOME/.pocketherdr/attachments/pane/$HERDR_PANE_ID/pr-evidence-XXXXXXXX")
cp /tmp/pr-apk/app-release.apk /tmp/pr-apk/app-release.apk.json "$EVIDENCE_ROOT/"
gate_status=0
PERF_PARENT_PANE=w1FE:pG node perf/prGate.mjs \
  --apk /tmp/pr-apk/app-release.apk \
  --host-root "$PWD" --serial emulator-5554 --out "$EVIDENCE_ROOT/run" \
  > "$EVIDENCE_ROOT/gate.log" 2>&1 || gate_status=$?
# Export after either success or failure, then preserve the result.
cp -a "$EVIDENCE_ROOT" "$HOME/.muxr/attachments/pane/$HERDR_PANE_ID/"
(exit "$gate_status")
```

Outside herdr, choose an explicit persistent evidence directory instead. Replace
`PERF_PARENT_PANE` with the actual coordinating pane, or omit it when working alone.
The gate exports its report, screenshot and archive to both attachment roots;
copy the APK/provenance and shell log to coordinating watchers as well when those
are deliverables. A failed run's evidence must remain available alongside reruns.

The build requires a private dependency directory, runs a frozen forced install
(including postinstall/patch-package), and verifies the native patch guard.
Copying another branch's already-patched node_modules is insufficient: it once
produced a working text terminal with no Kitty support or cell metrics. The build
uses package.json's version and an explicit ANDROID_VERSION_CODE or Git revision
count, generates a test keystore, and builds a release x86_64 APK.
The manifest beside it binds the APK SHA256 to the source revision and content
fingerprints and hashes of every actual patched dependency file. The gate checks
native parity, pulls back the installed APK and checks identical bytes;
it records package metadata, device model/API/renderer/size, host revision and
content digest, and a separate harness digest. Dirty source fingerprints
are recorded honestly. This is local build provenance, not signed attestation.
Never create a manifest for an unrelated prebuilt APK to make a check pass.

`--host-root` supports a separately built integration checkout. Its mobile/shared
source digest must match the APK manifest. Host/plugin-only differences can be
reported separately; a mobile change requires rebuilding the APK. The gate builds
the host checkout itself and verifies its source fingerprint stayed fixed during
the run. Do not edit measured source or run competing builds while measuring.

For a standalone Usage PR without the release viewer/graphics changes, use
`--flow usage` with an APK built from that PR's exact source. This runs the same
fresh pairing, isolated provider-switch/recency flow, APK/native/source identity
checks and cleanup. The report explicitly says performance was not measured;
`flow: usage` is not full-gate or graphics acceptance. The default is `--flow full`.

The full flow requires:

- Fresh pairing and a mounted herd under 30-pane/6-agent, 2 Hz title churn.
- A real file list and the seeded 250-line document in the real viewer.
- The session's real Changes list opens a git-backed native diff showing both
  removed/added markers. In that same viewer, zoom increases measured line height,
  unwrapped horizontal pan changes code-region pixels without leaving the file,
  and Wrap retains its enabled state. Two changed files and two separated hunks
  mount the combined navigator; all exposed navigator buttons, including overflow,
  must fit the measured emulator viewport without overlap. An 80-character CJK
  line must retain both end markers in one rendered Text node with the same
  row height as ASCII and wrap off. Missing full-text evidence fails this check. Screenshots retain
  the word-diff/CJK examples. CJK full horizontal extent and scrub source-line
  labels remain device-unverified; this does not cover every phone width.
- A real host session plus relative file path targets source line200 from offscreen
  on both cold app launch and warm navigation. The target must enter the upper
  visible code region. Removing only the owned relay tunnel must produce a bounded
  missing-session-root error on cold launch; restoring it must reach line200 again.
  This file-mode check does not claim diff deletion-collision
  or folded-target device coverage.
- Mounted text terminal plus a recorded real host attach, while graphics are off.
- Mounted terminal with an opaque magenta/teal Kitty checkerboard verified in
  the terminal framebuffer region, positive cell dimensions and positive delivered
  graphics frames during that window. Chrome or scroll-notch events cannot pass.
- Mounted Usage, OMP before OpenCode by timestamp (11:00 vs 10:00), and provider
  switching with token totals 150 → 300 → 150 and matching selected tab states.
  Without credentials, Go must show its actionable limits-unavailable state while
  retaining local tokens. No live authentication/error matrix is claimed.

Only Herdr and upstream usage fixture inputs are controlled. The fake Herdr
advertises the real code/status/terminal-keys plugin manifests. Its cwd is a real
scratch git repository. OMP/OpenCode databases contain synthetic aggregate rows.
A scratch Usage entry wrapper sets test-only clock/backend environment variables
then imports the original plugin: the production host intentionally sanitizes
plugin environment variables, and the harness does not weaken that boundary.
The ccusage CLI is an explicit fixture boundary; this flow does not test ccusage's
own database parser or call real provider credentials/quota services.

Every performance window is 35 seconds by default (`--seconds 30..120`) and must
contain at least 25 seconds of actual timestamped CPU and PSS samples. Raw tick
samples, timestamped PSS observations and gfxinfo dumps accompany derived numbers.
Missing samples, dead/restarted
runtime, JS busy above 60%, PSS drift above 100 MiB, a 30-second frame stall, no
rendered frames, fatal crashes and React update-depth errors fail. These broad
limits come from the existing emulator pathology profile. Jank percent/percentiles
are measured diagnostics here, not gesture-feel acceptance. Use the full release
gate for targeted jank, movement, input latency, graphics budget and memory soak.

Before measurement, a foreground transition surfaces deferred Android setup prompts.
The gate retains exact prompt/Cancel evidence and requires a quiet connected herd;
the fallback wait spans one 60-second fake-agent status cycle. This setup time is
not counted as a performance sample. Post-sample mount assertions stay strict.

Every feature must prove mount; a failed assertion stays a failure. An earlier
failure does not silently skip later features. The overall run has a 12-minute
deadline. All flows and adb commands have individual timeouts. A shared command
scope owns setup/build/adb/Maestro children; it aborts new work, kills process
groups, and awaits termination before releasing the emulator lock. Failed
termination retains the lock for inspection. Diagnostic export uses its own
bounded scope after the measurement scope closes. Evidence includes
report.json, UI XML, before/after screenshots, Maestro diagnostics, logcat, host
and relay logs, host journal and attach/input records, collected before stack
cleanup. A failed setup is not a performance pass. In a herdr pane, final bundles,
report and screenshot are copied to both PocketHerdr and muxr attachment watchers;
PERF_PARENT_PANE additionally exports to the coordinating pane.

This emulator gate runs locally. There is no GitHub emulator workflow or automatic
PR device job. Regular repository CI remains separate; its success does not prove
that these device flows ran. Before recommending the reviewed revision, inspect
`report.json` for the overall result, every required mounted feature, measured
sample coverage, and final source/native/harness freeze checks. Match the reported
host revision and APK mobile/native fingerprints to the intended combined source;
review screenshots and raw failures alongside the numbers. Attach the exact
command, APK provenance and evidence to the PR. Do not relabel an older passing
run as acceptance for changed mobile source, or treat synthetic checkerboard
coverage as evidence for a real terminal-browser memory workload or live voice.

Integration target: release/0.1.26. The PR209 surface harness starts from
origin/pr-review-209. Usage fixtures require the separate usage fix (OMP adapter,
OpenCode quota/status reporting, provider recency and mobile provider cap); its
main-based worktree cannot be substituted for the release APK. Integrate that
fix onto the release branch and rebuild a matching APK before claiming Usage PASS.

## Focused attachment and Settings acceptance

`--flow polish` uses the same APK/provenance, isolated stack, pairing, device lock and cleanup as the full gate. It does not measure performance or replace `--flow full`. It checks the real installed version on Connection & updates, uploads an owned generated image through Android's photo picker, verifies the composer thumbnail, opens its preview, measures zoom/pan pixels, and removes the image. It does not send a prompt. A missing picker selector fails with retained XML rather than selecting an arbitrary attachment. The same-version fixture does not prove the mismatch banner; version comparison has separate existing flow coverage.

The local `--flow rich` attachment check also needs `tesseract` with English data. Android WebView omits table cells from UIAutomator; this check retains OCR of the actual screenshot and requires the fixture cell text. It never treats the preview footer alone as CSV paint evidence.

### Focused Changes navigation

Use `--flow changes` with the same APK, source, install and pairing arguments to test only the native worktree and Branch / Working tree / Staged patch flow. It retains provenance, failure evidence, deadlines and cleanup; its report explicitly makes no performance acceptance claim. The default full run includes the same flow after the document checks. Back navigation uses the visible plugin header control and waits for the comparison tabs before selecting another scope.
