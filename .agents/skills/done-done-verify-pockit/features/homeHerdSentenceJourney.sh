#!/usr/bin/env bash
# Home's herd sentence, both halves in one done-done journey (home-quota-row.md,
# herd-working and its siblings): the release APK on an owned emulator held in
# each state the card can speak, then the installed PWA at phone and desktop
# widths. Writes the run's step record.
#   bash <this> <app-release.apk> <lab web export dir> <evidence dir>
# The export must carry the lab hook (EXPO_PUBLIC_MUXR_LAB_PAIR=1 yarn web:export)
# and the APK is a release build of the same commit; MUXR_LAB_AVD_HOME picks the
# emulator home. Run under the shared emulator lock and the memory gate.
set -u
wt=$PWD
apk=$1; web=$2; out=$3
features=.agents/skills/done-done-verify-pockit/features
mkdir -p "$out/native" "$out/pwa"

node "$features/homeHerdSentenceNative.mjs" "$apk" "$out/native" || exit 1
scripts/diagnostics/application/withPrivateXvfb.sh bash "$features/homeHerdSentencePwaCells.sh" "$web" "$out/pwa" || exit 1

node - "$apk" "$out" <<'JS'
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const [apk, out] = process.argv.slice(2);
let revision = 'unknown';
try { revision = JSON.parse(readFileSync(`${apk}.json`, 'utf8')).revision ?? 'unknown'; } catch { /* no build record */ }
const cells = JSON.parse(readFileSync(join(out, 'native', 'cells.json'), 'utf8'));
writeFileSync(join(out, 'steps.json'), JSON.stringify({
    target: { version: `muxr release APK ${revision}` },
    start: 'fresh app data on an owned Android emulator and a fresh installed-PWA profile; a private lab host (real relay and host over a fake Herdr, one agent) with nothing paired',
    steps: [
        'open the muxr://pair link from the lab host and tap Pair, then dismiss the background-battery invite',
        'Home shows the Right now card with the herd sentence for a working agent',
        'hold the agent blocked, failed and idle through the lab and relaunch Home for each',
        'close the agent pane so the herd is empty and relaunch Home',
        'read the card back at 360, 390, 445 and 270 dp, font 1.0 and 2.0, light and dark on the phone',
        'pair the installed PWA to the same lab and read the card back at those widths and on desktop 1280 and 1440',
    ],
    result: `Home's card says the exact sentence for each state in all ${cells.length} phone cells and every PWA cell, and never "Healthy" or "Busy"`,
}, null, 2));
JS
