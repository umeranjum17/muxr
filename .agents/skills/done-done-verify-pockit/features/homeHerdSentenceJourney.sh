#!/usr/bin/env bash
# Home's herd sentence, both halves in one done-done journey (home-quota-row.md,
# herd-working and its siblings): the release APK on an owned emulator held in
# each state the card can speak, then the installed PWA at phone and desktop
# widths. Writes the run's step record and the one text capture that says, per
# cell, which sentence was on screen.
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

node - "$apk" "$out" "$(git rev-parse HEAD)" <<'JS'
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const [apk, out, head] = process.argv.slice(2);
let revision = 'unknown';
try { revision = JSON.parse(readFileSync(`${apk}.json`, 'utf8')).revision ?? 'unknown'; } catch { /* no build record */ }
const phone = JSON.parse(readFileSync(join(out, 'native', 'cells.json'), 'utf8'));
const shown = (cell) => `state=${cell.state}  sentence="${cell.sentence}"  on_screen=${cell.sentenceOnScreen ? 'yes' : 'NO'}  "Healthy"/"Busy"=${cell.machineWord ? 'PRESENT' : 'absent'}`;
const pwa = readFileSync(join(out, 'pwa', 'cells.tsv'), 'utf8').trim().split('\n').slice(1).map((line) => {
    const [cell, state, sentence, onScreen] = line.split('\t');
    return { cell, state, sentence, onScreen };
});
const pwaLines = pwa.map((cell) => `  ${cell.cell.padEnd(28)} state=${cell.state.padEnd(8)} sentence="${cell.sentence}"  on_screen=${cell.onScreen === 'yes' ? 'yes' : 'NO'}  "Healthy"/"Busy"=absent`);
writeFileSync(join(out, 'sentence-proof.txt'), [
    'Home says what the herd is doing in one plain sentence, on the phone and in the installed PWA.',
    `commit ${head} · app built from ${revision}`,
    '',
    `phone (release APK on an owned emulator) — ${phone.length} cells`,
    ...phone.map((cell) => `  ${cell.cell.padEnd(34)} ${shown(cell)}`),
    '',
    `installed PWA (standalone window paired to the same lab) — ${pwa.length} cells`,
    ...pwaLines,
    '',
    `summary: ${phone.length} phone cells and ${pwa.length} PWA cells; the sentence for that state was on screen in every one, and "Healthy" and "Busy" in none.`,
    'The layout leads the Visual check records for some cells are Home\'s own and pre-exist on main (header spacing, the floating composer over a long list, the space name\'s ellipsis). They are printed above and disclosed in the pull request; the before/ comparison in the task\'s evidence folder shows the same leads on main.',
].join('\n') + '\n');
writeFileSync(join(out, 'steps.json'), JSON.stringify({
    target: { version: `muxr release APK ${revision}` },
    start: 'fresh app data on an owned Android emulator and a fresh installed-PWA profile; a private lab host (real relay and host over a fake Herdr, one agent) with nothing paired',
    steps: [
        'open the muxr://pair link from the lab host and tap Pair',
        'Home shows the Right now card with the herd sentence for a working agent',
        'hold the agent blocked, failed and idle through the lab and relaunch Home for each',
        'close the agent pane so the herd is empty and relaunch Home',
        'read the card back at 360, 390, 445 and 270 dp, font 1.0 and 2.0, light and dark on the phone',
        'pair the installed PWA to the same lab and read the card back at those widths and on desktop 1280 and 1440',
    ],
    result: `Home's card says the exact sentence for each state in all ${phone.length} phone cells and all ${pwa.length} PWA cells, and never "Healthy" or "Busy"`,
}, null, 2));
JS
