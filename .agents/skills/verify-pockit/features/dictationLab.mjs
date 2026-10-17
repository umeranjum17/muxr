// File-fed dictation takes on a task-owned emulator against the perf fake stack, with
// a watch that fails the run if realtime voice ever starts. See dictation-silence-gate.md.
// Usage, from the repo root after `yarn build`:
//   node .agents/skills/verify-pockit/features/dictationLab.mjs --apk <lab APK> --evidence <dir> \
//     --avd-home <dir> [--launcher <cmd>]
// Every tap is on a control found by its label in a dump taken just before it: a
// stale coordinate or a guessed element lands on Send or Talk, and Talk starts
// realtime voice over the composer.
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { bootOwnedEmulator } from '../../../../perf/lib/androidEmulator.mjs';
import { dismissKeyboard, dismissPrompts, dumpUiXml, screenshot } from '../../../../perf/lib/androidSignals.mjs';
import { startFakeStack } from '../../../../perf/lib/fakeStack.mjs';
import { pairPhone } from '../../../../perf/lib/pairPhone.mjs';

const { values: opts } = parseArgs({ options: {
    apk: { type: 'string' }, evidence: { type: 'string' }, 'avd-home': { type: 'string' },
    launcher: { type: 'string' },
} });
if (!opts.apk || !opts.evidence || !opts['avd-home']) throw new Error('--apk, --evidence and --avd-home are required');
const PKG = 'com.trymuxr.app';
const FEED = `/data/data/${PKG}/files/muxr-lab-dictation.pcm`;
const EVIDENCE = resolve(opts.evidence);
const FIXTURES = resolve('scripts/dictation/fixtures');
mkdirSync(EVIDENCE, { recursive: true });
const SCRATCH = mkdtempSync(join(tmpdir(), 'muxr-dictation-lab-'));
const exec = promisify(execFile);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const say = (line) => { const out = `${new Date().toISOString()} ${line}`; console.log(out); appendFileSync(join(EVIDENCE, 'dictation-lab.log'), `${out}\n`); };
let serial = '';
const adb = async (args, timeout = 60_000) => (await exec('adb', ['-s', serial, ...args], { timeout, maxBuffer: 64 << 20 })).stdout;

// --- screen reading --------------------------------------------------------
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
function nodes(xml) {
    return [...xml.matchAll(/<node [^>]*>/g)].map(([tag]) => {
        const get = (key) => unescape(tag.match(new RegExp(` ${key}="([^"]*)"`))?.[1] ?? '');
        const box = get('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)?.slice(1).map(Number) ?? [0, 0, 0, 0];
        return { text: get('text'), desc: get('content-desc'), cls: get('class'), box };
    });
}
async function screen() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const xml = await dumpUiXml(30_000);
        if (xml !== '') { const found = nodes(xml); noteRealtime(found); return found; }
        await sleep(1500);
    }
    return [];
}
const labelled = (found, label) => found.find((n) => n.desc === label || n.text === label);
const center = ({ box: [l, t, r, b] }) => [Math.round((l + r) / 2), Math.round((t + b) / 2)];
const tap = ([x, y]) => adb(['shell', 'input', 'tap', String(x), String(y)]);
const PLACEHOLDER = /^(Plan, ask, build…|Ask .*|Run a command.*)$/;
// Closed, the composer shows its draft as one line of text left of Dictate; open, it is the EditText.
function draftField(found) {
    const input = found.find((n) => n.cls === 'android.widget.EditText');
    if (input !== undefined) return input;
    const mic = labelled(found, 'Dictate');
    if (mic === undefined) return undefined;
    const row = (mic.box[1] + mic.box[3]) / 2;
    // The widest text on Dictate's row: the Talk button's icon glyph sits on that row too, and tapping
    // it to "clear the draft" starts realtime voice.
    const width = ({ box: [l, , r] }) => r - l;
    return found.filter((n) => /\.(EditText|TextView)$/.test(n.cls) && n.box[1] <= row && row <= n.box[3] && n.box[2] <= mic.box[0]
        && n.text !== '' && !/^[\uE000-\uF8FF]+$/.test(n.text)).sort((a, b) => width(b) - width(a))[0];
}
const draft = (found) => {
    const field = draftField(found);
    if (field === undefined) throw new Error('no draft field on the settled composer');
    return PLACEHOLDER.test(field.text) ? '' : field.text;
};

// --- realtime watch ----------------------------------------------------------
// Realtime voice is live while its microphone foreground service runs; its
// floating pill and sheet are what covers the composer.
const sightings = [];
let screensRead = 0;
function realtimeOn(found) {
    const pill = found.find((n) => / Open realtime conversation$/.test(n.desc));
    if (pill) return `overlay "${pill.desc}"`;
    if (labelled(found, 'Realtime') && found.some((n) => /^(Asleep — |Connecting…|Listening|Thinking…|Speaking)/.test(n.text))) return 'realtime sheet';
    if (labelled(found, 'Realtime conversation')) return 'realtime conversation alert';
    return null;
}
let phase = 'boot';
function noteRealtime(found) {
    screensRead += 1;
    const seen = realtimeOn(found);
    if (seen !== null) { sightings.push(`${phase}: ${seen}`); say(`REALTIME ${phase}: ${seen}`); }
}
let serviceRuns = 0;
const watched = { attempts: 0, samples: 0 };
async function serviceWatch(stopped) {
    let last = null;
    while (!stopped.done) {
        watched.attempts += 1;
        // VoiceOverlayService also hosts the herd keep-alive (dataSync, 0x1) while agents work; only the
        // microphone type (0x80) is realtime voice.
        const dump = await adb(['shell', 'dumpsys', 'activity', 'services', PKG], 30_000).catch(() => null);
        if (dump !== null) {
            watched.samples += 1;
            const types = dump.includes('VoiceOverlayService') ? [...dump.matchAll(/(?:foregroundServiceType|types)=0x([0-9a-f]+)/gi)].map((m) => parseInt(m[1], 16)) : [];
            const running = types.some((type) => (type & 0x80) !== 0);
            if (running) serviceRuns += 1;
            if (running !== last) { say(`microphone service ${running ? 'RUNNING' : 'not running'} (${phase}; foreground types ${types.map((t) => `0x${t.toString(16)}`).join(',') || 'none'})`); last = running; }
        }
        await sleep(2000);
    }
}

// --- takes -------------------------------------------------------------------
async function pcm(name, wav) {
    const out = join(SCRATCH, `${name}.pcm`);
    if (wav) await exec('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-f', 's16le', '-ac', '1', '-ar', '16000', out]);
    else {
        // 40 s of near-silence (past the kit's 30 s window): Gaussian room noise at about 0.003 RMS.
        // 120 s did not settle in 15 min on a loaded fleet emulator.
        const samples = new Int16Array(16_000 * 40);
        let seed = 7;
        const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) + 1) / 4294967297;
        for (let i = 0; i < samples.length; i += 1) samples[i] = Math.round(Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand()) * 0.003 * 32767);
        writeFileSync(out, Buffer.from(samples.buffer));
    }
    return out;
}
async function feed(file) {
    await adb(['push', file, '/data/local/tmp/muxr-lab-dictation.pcm'], 120_000);
    const owner = (await adb(['shell', 'stat', '-c', '%u:%g', `/data/data/${PKG}`])).trim();
    await adb(['shell', `mkdir -p /data/data/${PKG}/files && cp /data/local/tmp/muxr-lab-dictation.pcm ${FEED} && chown ${owner} ${FEED} && chmod 600 ${FEED} && restorecon ${FEED}`]);
}
async function waitFor(what, test, seconds) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
        const found = await screen();
        if (test(found)) return found;
        await sleep(2000);
    }
    throw new Error(`${what} never appeared within ${seconds}s`);
}
const recording = (found) => labelled(found, 'Stop dictation') !== undefined;
const settled = (found) => labelled(found, 'Dictate') !== undefined && !recording(found) && !found.some((n) => /^(Transcribing…|Cancel dictation)$/.test(n.text || n.desc));

async function take(name, file, expect) {
    phase = name;
    await feed(file);
    await screenshot(join(EVIDENCE, `${name}-before.png`));
    const mic = labelled(await screen(), 'Dictate');
    if (mic === undefined) throw new Error(`${name}: no Dictate control on screen`);
    await tap(center(mic));
    let found = await waitFor(`${name}: recording`, recording, 60);
    await sleep(3000);
    // Exactly one stop, on the stop control as it is right now. A second tap on
    // the same spot after the take settles lands on Send or Talk instead.
    const stop = labelled(await screen(), 'Stop dictation');
    if (stop === undefined) throw new Error(`${name}: Stop dictation gone before the tap`);
    await tap(center(stop));
    found = await waitFor(`${name}: settled draft`, settled, 900);
    const text = draft(found);
    await screenshot(join(EVIDENCE, `${name}-after.png`));
    writeFileSync(join(EVIDENCE, `${name}-after.xml.json`), JSON.stringify(found.filter((n) => n.text || n.desc), null, 1));
    const ok = expect(text);
    say(`take ${name}: draft ${JSON.stringify(text)} ${ok ? 'PASS' : 'FAIL'}`);
    return { found, ok };
}
async function clearDraft() {
    const field = draftField(await screen());
    if (field === undefined) return;
    await tap(center(field));
    const input = (await waitFor('open composer', (found) => found.some((n) => n.cls === 'android.widget.EditText'), 30)).find((n) => n.cls === 'android.widget.EditText');
    await tap(center(input));
    await adb(['shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_A']);
    await adb(['shell', 'input', 'keyevent', 'KEYCODE_DEL']);
    await dismissKeyboard();
    // The draft opens the full composer screen; the takes run on Home.
    for (let back = 0; back < 3 && !atHome(await screen()); back += 1) {
        await adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
        await sleep(1500);
    }
    await home();
}
const atHome = (found) => labelled(found, 'connected') !== undefined && labelled(found, 'Dictate') !== undefined;
async function home(seconds = 120) {
    return waitFor('connected Home composer', atHome, seconds);
}
// perf/flows/pair.yaml predates the "Let's connect" first run, so the offer opens as
// a deep link (as in pairing-consent.md) and Pair is tapped on the consent card.
async function openOffer(_flow, { PAIR_CODE }) {
    try {
        // A loaded emulator can restart system_server after a slow install ("Can't find service: activity").
        for (let wait = 0; wait < 40 && !(await adb(['shell', 'service', 'check', 'activity']).catch(() => '')).includes(': found'); wait += 1) await sleep(3000);
        await adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'muxr://pair#${PAIR_CODE}'`, PKG]);
        for (let attempt = 0; attempt < 8; attempt += 1) {
            await sleep(2500);
            const pair = labelled(await screen(), 'Pair');
            if (pair) {
                await tap(center(pair));
                // pairPhone releases the offer when this returns, and the host approves over that
                // socket, so stay until the phone is connected (the old flow's last wait).
                await waitFor('connected after Pair', (found) => labelled(found, 'connected') !== undefined, 90);
                return { code: 0, output: 'paired through the consent card' };
            }
            await adb(['shell', 'input', 'swipe', '540', '1800', '540', '800', '300']);
        }
        return { code: 1, output: 'the consent card never showed Pair' };
    } catch (error) {
        return { code: 1, output: String(error?.message ?? error) };
    }
}

// --- journey -----------------------------------------------------------------
const results = [];
const stopped = { done: false };
let emulator;
let stack;
let watch;
// A lock timeout ends this run with SIGTERM; it must not strand the emulator or stack.
process.once('SIGTERM', async () => {
    say('RESULT FAIL: terminated');
    stopped.done = true;
    stack?.stop();
    await emulator?.stop();
    rmSync(SCRATCH, { recursive: true, force: true });
    process.exit(1);
});
try {
    emulator = await bootOwnedEmulator({ name: 'muxr-dictation-lab', avdHome: resolve(opts['avd-home']), bootTimeoutMs: 720_000, launcher: opts.launcher ? [opts.launcher] : [] });
    serial = emulator.serial;
    say(`emulator ${serial} booted`);
    stack = await startFakeStack({ panes: 3, agents: 2 });
    say(`fake stack relay port ${stack.relayPort}`);
    watch = serviceWatch(stopped);
    const quiet = await pcm('quiet', join(FIXTURES, 'quiet.wav'));
    const clean = await pcm('clean', join(FIXTURES, 'clean.wav'));
    const silence = await pcm('silence');
    const fixtures = JSON.parse(readFileSync(join(FIXTURES, 'fixtures.json'), 'utf8')).fixtures;
    const meant = (id) => fixtures.find((f) => f.id === id).text;
    const words = (text) => text.toLowerCase().replace(/[^a-z ]/g, '').split(' ').filter(Boolean);
    const near = (heard, meant) => { const want = new Set(words(meant)); const got = words(heard); return got.length > 0 && got.filter((w) => want.has(w)).length / want.size >= 0.6; };

    phase = 'clean-install';
    await adb(['uninstall', PKG], 120_000).catch(() => undefined);
    await adb(['install', opts.apk], 300_000);
    say(`clean install: ${(await adb(['shell', 'dumpsys', 'package', PKG])).match(/firstInstallTime=\S+ \S+/)?.[0]}`);
    for (const permission of ['RECORD_AUDIO', 'POST_NOTIFICATIONS']) await adb(['shell', 'pm', 'grant', PKG, `android.permission.${permission}`]);
    const paired = await pairPhone({ stack, maestro: openOffer });
    if (!paired.ok) throw new Error(`pairing failed: ${paired.why}`);
    // Root restarts adbd and drops adb reverse, so it waits until pairing is done; only the feed copy needs it.
    await adb(['root']);
    await adb(['wait-for-device'], 120_000);
    await adb(['reverse', `tcp:${stack.relayPort}`, `tcp:${stack.relayPort}`]); // the adbd restart dropped it
    await dismissPrompts(['CANCEL', 'Not now', 'Deny', 'Later']);
    await home();
    results.push(await take('clean-quiet', quiet, (text) => near(text, meant('quiet'))));
    await clearDraft();
    results.push(await take('clean-silence', silence, (text) => text.trim() === ''));
    results.push(await take('clean-clean', clean, (text) => near(text, meant('clean'))));
    await clearDraft();

    phase = 'over-old-data';
    await adb(['install', '-r', opts.apk], 300_000);
    await adb(['shell', 'monkey', '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1']);
    await dismissPrompts(['CANCEL', 'Not now', 'Deny', 'Later']);
    await home(180);
    results.push(await take('reinstall-quiet', quiet, (text) => near(text, meant('quiet'))));

    const appops = (await adb(['shell', 'cmd', 'appops', 'get', PKG, 'RECORD_AUDIO'])).trim();
    say(`appops: ${appops}`);
    const micUsed = /(^|; )time=|running/.test(appops);
    const watchOk = watched.samples > 0 && watched.samples * 2 >= watched.attempts;
    const clear = watchOk && sightings.length === 0 && serviceRuns === 0 && !micUsed;
    say(`realtime: ${clear ? 'none opened' : 'OPENED'} (microphone service samples running=${serviceRuns} of ${watched.samples} successful dumps in ${watched.attempts} attempts, RECORD_AUDIO ${micUsed ? 'accessed' : 'never accessed'}, realtime on screen in ${sightings.length} of ${screensRead} screens)`);

    say(`RESULT ${clear && results.every((r) => r.ok) ? 'PASS' : 'FAIL'}`);
} catch (error) {
    say(`RESULT FAIL: ${error instanceof Error ? error.message : String(error)}`);
    if (serial) await screenshot(join(EVIDENCE, 'failure.png')).catch(() => undefined);
    process.exitCode = 1;
} finally {
    stopped.done = true;
    await watch?.catch(() => undefined);
    stack?.stop();
    await emulator?.stop();
    rmSync(SCRATCH, { recursive: true, force: true });
    say('stack and emulator stopped');
}
