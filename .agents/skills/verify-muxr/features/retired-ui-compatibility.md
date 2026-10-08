# Connect an older phone without optional UI plugins

Released post-link-cutover phone apps can open Home and a session with a newer host: the retired optional UI catalog is empty, stale manifest reads are valid empty graphs, and stale writes report a plain unsupported error.

## Sub-features

- All five deprecated `plugin.*` requests still receive recognised replies.
- Shared text bounds, Usage rendering, Applications and native configuration plugins remain independent of the retired runtime.
- The host remains responsive after stale requests.

## How to get to it (user POV)

Install the oldest still-compatible released Android APK, pair to your private lab computer, open Home, then open a session. No optional plugin mounts or failure screen should appear.

## Driving it with the private stack

Preconditions: build this checkout; use an explicitly isolated non-default Herdr lab through `HERDR_LAB_HELPER`. Never use the owner's service or pairing state. This recipe uses a real Herdr-backed host rather than the baseline fake source.

1. Run `node scripts/diagnostics/application/checkHostContract.mjs --lab`. It owns its relay on port 0, pairs a real device link, sends all five requests, checks their exact answers, and asks for machine hello and sessions afterward. Retain stdout and exit code.
2. Read released plugin callers before changing replies. `plugin.list` must return `[]`, not null; a manifest reply must have `schemaVersion: 1` and an empty `contributions` array. Mutation errors are `plugins are no longer supported`.
3. Obtain the oldest release after the published pairing transport cutover, without modifying or re-signing its APK. In the guarded emulator lock, install it, pair through the lab host's ordinary pairing offer, open Home and a real lab session. Every adb call must name the owned serial.
4. Save Home/session screenshots, installed APK identity, and journey logcat. Review the screenshots and assert no fatal/crash records. Capture light and dark if the tested app supports both. Kill only the owned emulator and lab processes.

## Gotchas

- Pre-cutover releases cannot pair with the current link transport. The v0.2.1 release explicitly requires both sides to update and pair again; do not label v0.1.0 or v0.2.0 a still-supported pairing client.
- Empty success data is critical: released catalog code calls `.filter` and manifests' `.contributions` without null guards.
- Herdr's own `plugin.list` still powers Applications; it is not the deprecated phone-to-host request. Keep that registry and the stale-registration filter.
- Do not confuse a passing source check or host-only request run with Android acceptance. Record blocked/unrun native proof honestly.
