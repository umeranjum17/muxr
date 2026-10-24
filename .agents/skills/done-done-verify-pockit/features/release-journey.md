# A stable release passes the real-app journey on its exact build

npm `latest` and the stable APK (GitHub Latest and the public channel) move
only after the `phone-attach` journey passed on the release's own APK and npm
tarball. The journey pairs, attaches through pane churn, sends text from the
box, scrolls the agent's history back and forward fast, opens Usage and comes
back, and counts exactly one host alive. It times the first attach and the
scroll against the budgets in `scripts/release/domain/releaseJourney.mjs`.

## Sub-features

- `x86_64-twin` on an emulator the journey runs the APK `journey-apk.yml` builds clean from the release tag; `checkReleaseApk.mjs` checks the released arm64 APK's signature, manifest, native libraries, version, its JS bundle and dex against the twin's, and the twin's source against the sealed release, and writes `.done-done-receipts/builds/<v>.release-apk.json` with both digests. The gate takes another APK digest only through that committed record, whose twin digest must be the one the cited result ran.
- `exact-build` the journey records the sha256 of the APK it installed and the tarball its host ran from in `release-build.json`; the gate compares them with the release's sealed manifest and refuses any other build of the same version.
- `promote-latest` npm `latest` moves only when the captain runs `release.yml` by hand with `captain_tested` and the version after his own phone test, and `scripts/release/presentation/acceptStable.mjs` accepts the exact tarball it packed against the receipt; it then publishes straight under `latest` through trusted publishing, no npm login or token. A push never publishes a stable version. The script never publishes, so it is also the dry run.
- `stable-apk` `release.yml`'s stable promote runs `checkJourneyReceipt.mjs --tag v<v>` before GitHub Latest and the catalog.
- `one-host` after Usage, the processes in the lab host's own tree that hold a link to the lab relay number exactly one (0.2.8 booted a second host from the Usage ledger child).
- `budgets` on a phone run, attach and scroll times over budget fail the gate, not the journey: the journey records what it measured. A twin run's times never gate (`TWIN_BUDGETS`); `checkJourneyReceipt.mjs` prints them labelled `emulator-under-load, informational`, and the owner's phone test is the timing gate.

## How to get to it (user POV)

A maintainer promoting a stable version: run the journey on the candidate's
assets, commit the receipt and result to `main`, then the captain runs `release.yml` by hand with `captain_tested` and `version` `<v>` (from `main`, or the `v<v>` tag once `main` moved on), which publishes the version as `latest`.

## Driving it with the private stack

The stable APK carries only `arm64-v8a` libraries, stored uncompressed and
never extracted: on an x86_64 emulator with ARM translation it installs, then
SoLoader looks only in `base.apk!/lib/x86_64` and crashes at launch
(`couldn't find DSO to load: libreactnative.so`). So the emulator runs the
release's x86_64 twin: download the `journey-apk-<v>` artifact of **release
journey APK** (`journey-apk.yml`, dispatched with the version), or build it the
same way from a clean checkout of the tag
(`MUXR_PR_APK_ABI=x86_64 ANDROID_VERSION_CODE=<code from the APK name> MUXR_EAS_PROJECT_ID=<eas.json production> node perf/buildPrApk.mjs <out>`, then
`node scripts/release/presentation/checkReleaseApk.mjs --version <v> --release <release dir> --journey-apk <out>/app-release.apk`).
An arm64 device runs the release APK itself and needs no APK check.

Preconditions: an authorized Herdr lab (`HERDR_LAB_HELPER`, a 2-char label
such as `rj` with `FM_HERDR_LAB_STATE_DIR=/tmp/rj`, provisioned before the run
with `HERDR_LAB_PREPROVISIONED=1`), a task-owned emulator under the shared
emulator lock, and the release's assets:
`gh release download v<v> --pattern '*.apk' --pattern '*.tgz' --pattern release-manifest.json --pattern signer.txt --pattern compiled-manifest.xml --pattern native-provenance.json`.

1. Boot an Android 35 x86_64 AVD with 4 GB (`bootOwnedEmulator` in `perf/lib/androidEmulator.mjs`, launcher `nice -n 10`) and let it settle about three minutes after boot: a fresh AVD installing at once froze its guest mid-`pm install`.
2. `PHONE_SERIAL=<serial> PHONE_APK=<apk> (or PHONE_USE_INSTALLED=1) PHONE_PACKAGE=<tgz> PHONE_ATTACH_ROOT=$(mktemp -d ~/.cache/fms/rj.XXXX) MUXR_LAB_MACHINE_NAME='Umer lab' done-done run phone-attach`.
   The tarball is installed with `npm install --prefix <root>/pkg --ignore-scripts`; the lab runs its `relay.js` and `host.js` (`MUXR_LAB_PACKAGE_DIR`).
3. Read `release-build.json` in the run's evidence folder: `result: pass`, every step `pass`, `hosts: 1`, `timings.attachMs` and `timings.scrollMs`.
4. `done-done receipt --outcome "<claim in the journey's step words>" <captures> <evidence>/release-build.json` (done-done cites only files a run wrote), then commit the receipt at `.done-done-receipts/<head>.json`, the result at `.done-done-receipts/builds/<v>.json` and the APK check at `.done-done-receipts/builds/<v>.release-apk.json`.
5. `node scripts/release/presentation/acceptStable.mjs --version <v> --package <the release's .tgz> --captain-tested <v>` prints `may be published as npm latest`; without `--captain-tested <v>` (a push), without a result, with a result for another build, or for another tarball, it prints `npm latest stays where it is:` and the reason (and `accepted=false` to `GITHUB_OUTPUT` when set).

Twin gate journey: `TWIN_APK=<twin apk> done-done run release-twin-gate` (`releaseTwinGateLab.mjs`) checks the real release's APK against its twin, refuses the arm64 APK as its own twin, and runs the gate and a push's dry run on the receipts at HEAD; `gate.log` shows each.

Gate journey: `done-done run release-latest-gate` (`releaseLatestGateLab.mjs`) runs release.yml's own `accepted` step command on the newest stable GitHub release's real manifest and tarball, with a stand-in receipt in a scratch clone, as a push and as hand runs; `gate.log` shows the publish step running only for the hand run naming the tested version with the receipt. It publishes nothing.

Flow test: `scripts/release/checkJourneyReceipt.spec.mjs` (no result, another APK, a rebuilt tarball, matching build, the x86_64 twin with no, a failed or another commit's APK check and with a passing one, a slow twin accepted with labelled times and the same times refused on a phone run, and `acceptStable` refusing a push with no captain-tested version and a tarball packed after the tag).

## Gotchas

- npm 12 answers `npm view <pkg>@<v> <field> --json` with a one-element array; the registry readers unwrap it. Before that fix every local registry check read "published from different bytes".
- `dumpsys input_method` runs past a megabyte on the test phone: read only `mInputShown` on the device.
- Baseline (0.2.10, test phone, 22 Oct): scroll 2.3 s back and 3.7 s forward, one host after Usage. Its first attach of 9.7-11.5 s counted the journey's own ui dumps and one-second polls; `attachMs` now runs from the tap to the host's new terminal stream, awaited with no dump running, and 0.2.12 measured 0.4-1.0 s on the x86_64 emulator.
- Never time anything while a ui dump or other `execFileSync` runs: the journey's process is blocked, so the lab host's lines are read when the call returns, not when they were written.
- Usage opens from the terminal's `Pane actions` menu; a dump with no `Terminal surface` and a `Usage` node is the Usage screen.
- The scroll uses 60 ms swipes (flings); a slow swipe is a long-press selection, not a scroll.
- Captures skip any screen with the computer's own name; `MUXR_LAB_MACHINE_NAME` keeps the real hostname off the phone.
- Release path only: no visual surface changes; visual check: n/a (no UI change).
- Twin on a loaded emulator (23 Oct, load 40-70): first attach 36.8-37.5 s, scroll 14.7 s; a fresh install also raises System UI ANR and notification-permission dialogs over the app (answer Wait, `pm grant ... POST_NOTIFICATIONS`).
