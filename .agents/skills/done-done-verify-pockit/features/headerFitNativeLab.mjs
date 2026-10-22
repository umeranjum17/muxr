// The agent header fits a phone with a long task: boots an owned emulator, runs
// chatFakeLab.mjs over adb, pairs a lab-id release APK and captures the agent
// header in chat and terminal view at 360 and 390 dp, light and dark, twice: quiet
// (idle, task "Umer", no changes) and crowded (Working, a long task, three changed
// files). Beside the title button sit the view toggle, the pane count and ⋮; that
// strip must be the same pixels in both, or something in the crowded row painted
// over them. Then 270 dp and font 2.0 cells through visualCheck.mjs for the
// self-review. Exits non-zero on any defect. See chat-header-fit.md. Run from the
// repo root, inside the emulator lock:
// node .agents/skills/done-done-verify-pockit/features/headerFitNativeLab.mjs <apk> <evidenceDir> <avdHome>
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [apk, evidence, avdHome] = process.argv.slice(2);
const repo = process.cwd();
const LONG_TASK = 'Umer: make the checkout total include shipping and taxes for every region';
const { bootOwnedEmulator } = await import(join(repo, 'perf/lib/androidEmulator.mjs'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
mkdirSync(evidence, { recursive: true });
const log = (m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); appendFileSync(join(evidence, 'journey.log'), `${line}\n`); };

const emu = await bootOwnedEmulator({ name: 'mxheaderfit', avdHome, systemImage: 'system-images;android-35;google_apis;x86_64', launcher: ['nice', '-n', '10'] });
const serial = emu.serial;
log(`emulator ${serial}`);
const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 120_000 });
const sh = (cmd) => adb('shell', cmd);
// A loaded host drops the odd dump ("null root node"); the next one answers.
const nodes = () => {
    for (let attempt = 0; ; attempt += 1) {
        try { sh('uiautomator dump /sdcard/d.xml >/dev/null'); return adb('exec-out', 'cat', '/sdcard/d.xml').match(/<node\s[^>]*>/g) ?? []; } catch (error) { if (attempt === 2) throw error; }
    }
};
const labelsOf = (node) => [/text="([^"]*)"/.exec(node)?.[1] ?? '', /content-desc="([^"]*)"/.exec(node)?.[1] ?? ''];
const matches = (node, re) => labelsOf(node).some((label) => re.test(label));
const boundsOf = (node) => /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node).slice(1).map(Number);
const find = async (re, seconds = 30) => {
    for (let i = 0; i < seconds; i += 2) {
        const hits = nodes().filter((node) => matches(node, re));
        if (hits.length > 0) return hits.at(-1);
        await sleep(2000);
    }
    throw new Error(`never saw ${re}`);
};
const tapNode = async (node) => { const [x1, y1, x2, y2] = boundsOf(node); sh(`input tap ${(x1 + x2) >> 1} ${(y1 + y2) >> 1}`); await sleep(1200); };
const tap = async (re, seconds) => tapNode(await find(re, seconds));

let lab;
const defects = [];
try {
    // A 170 MB release APK on a loaded host can take minutes to install.
    execFileSync('adb', ['-s', serial, 'install', '-r', apk], { encoding: 'utf8', timeout: 600_000 });
    const pkg = sh('pm list packages').split('\n').map((line) => line.replace('package:', '').trim()).find((name) => name.includes('headerfit'));
    if (pkg === undefined) throw new Error('the lab-id app did not install');
    const activity = sh(`cmd package resolve-activity --brief ${pkg}`).trim().split('\n').pop();
    sh(`pm clear ${pkg}`);

    lab = spawn(process.execPath, ['--input-type=module', '-e', readFileSync(join(repo, '.agents/skills/done-done-verify-pockit/features/chatFakeLab.mjs'), 'utf8')],
        { cwd: repo, env: { ...process.env, CHAT_LAB_SERIAL: serial }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    lab.stdout.on('data', (chunk) => { out += String(chunk); });
    lab.stderr.on('data', (chunk) => { out += String(chunk); });
    const line = async (re) => { for (let i = 0; i < 120; i += 1) { const hit = re.exec(out); if (hit) return hit[1]; await sleep(500); } throw new Error(`lab never said ${re}:\n${out}`); };
    const command = async (text) => { const seen = out.length; lab.stdin.write(`${text}\n`); for (let i = 0; i < 40; i += 1) { if (/lab (did|failed): /.test(out.slice(seen))) break; await sleep(250); } if (/lab failed/.test(out.slice(seen))) throw new Error(out.slice(seen)); };
    await line(/lab ready: (.*)/);
    await command('status idle Umer');
    lab.kill('SIGUSR2');
    const link = await line(/native link: (\S+)/);
    log('lab ready, native link minted');

    sh('wm size 1080x2376'); sh('wm density 443'); sh('settings put system font_scale 1.0'); sh('cmd uimode night yes');
    sh(`am start -n ${activity}`);
    await sleep(4000);
    sh(`am start -a android.intent.action.VIEW -d 'muxr-dev://pair#${link}' -n ${activity}`);
    await tap(/^Pair$/, 60);
    await find(/Claude 1/, 90);
    log('paired');

    // A relaunch reopens the last agent and reads its changes afresh; from Home the composer covers the bottom rows.
    // A loaded host can take a while to connect the reopened agent; its toggle appears once it has.
    const inAgent = async (view) => {
        for (let wait = 0; wait < 10; wait += 1) {
            const here = nodes();
            if (here.some((node) => matches(node, /^New pane$/))) { await tap(/^Done$/); continue; }
            const toggle = here.find((node) => matches(node, view === 'chat' ? /^Chat view$/ : /^Terminal view$/));
            if (toggle !== undefined) {
                if (!/selected="true"/.test(toggle)) await tapNode(toggle);
                return true;
            }
            if (!here.some((node) => matches(node, /^Back$/))) return false;
            await sleep(3000);
        }
        return false;
    };
    const openAgent = async (view) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            sh(`am force-stop ${pkg}`);
            sh(`am start -n ${activity}`);
            await sleep(4000);
            if (await inAgent(view)) { await sleep(2500); return; }
            await find(/Claude 1/, 60);
            const cards = nodes().filter((node) => matches(node, /Claude 1/) && boundsOf(node)[3] < 1700 && /clickable="true"/.test(node));
            const card = cards[attempt % Math.max(1, cards.length)];
            if (card !== undefined) {
                await tapNode(card);
                await sleep(2000);
                if (await inAgent(view)) { await sleep(2500); return; }
            }
            sh('screencap -p /sdcard/open-miss.png'); adb('pull', '/sdcard/open-miss.png', join(evidence, `open-miss-${attempt}.png`));
            log(`open attempt ${attempt} missed the agent`);
        }
        throw new Error('could not open the Claude agent');
    };
    // The header row: the title button (its label ends "Open panes") and the controls after it, on one line.
    const header = (dump) => {
        const title = dump.find((node) => matches(node, /Open panes$/));
        const menu = dump.find((node) => matches(node, /^Pane actions/));
        if (title === undefined || menu === undefined) throw new Error('no header row in the dump');
        const [tl, tt, tr, tb] = boundsOf(title);
        const [, mt, mr, mb] = boundsOf(menu);
        return { titleRight: tr, titleLeft: tl, top: Math.min(tt, mt), bottom: Math.max(tb, mb), right: mr };
    };
    const capture = async (dir, name, check) => {
        mkdirSync(dir, { recursive: true });
        let report;
        try {
            report = execFileSync('node', [join(repo, '.agents/skills/done-done-verify-pockit/features/visualCheck.mjs'), serial, dir, name], { encoding: 'utf8' });
        } catch (cause) {
            report = `${cause.stdout ?? ''}${cause.stderr ?? ''}`;
        }
        writeFileSync(join(dir, `${name}.check.txt`), report);
        // A task too long for the row ends in an ellipsis by design, the branch row shows the fake
        // Herdr's /tmp folder (lab data), and the chat covers the attached terminal on purpose (the
        // same leads on main); every other lead is a defect.
        const leads = report.split('\n').filter((row) => row.startsWith('DEFECT')
            && !(row.includes('ellipsis cuts the text') && (row.includes(LONG_TASK.slice(0, 20)) || row.includes('/tmp/muxr-perf-')))
            && !row.includes('overlap: "Terminal surface"'));
        if (check) for (const lead of leads) defects.push(lead);
        return parseDump(readFileSync(join(dir, `${name}.xml`), 'utf8'));
    };
    const parseDump = (xml) => xml.match(/<node\s[^>]*>/g) ?? [];
    const crop = (png, box, to) => execFileSync('magick', [png, '-crop', `${box.right - box.titleRight}x${box.bottom - box.top}+${box.titleRight}+${box.top}`, '+repage', to]);
    const differing = (a, b) => {
        try { return Number(execFileSync('magick', ['compare', '-metric', 'AE', '-fuzz', '3%', a, b, 'null:'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || 0); }
        catch (cause) { return Number(String(cause.stderr).trim().split(/\s/)[0]); }
    };

    const cells = [];
    for (const width of ['360', '390']) for (const theme of ['dark', 'light']) for (const view of ['chat', 'terminal']) cells.push({ width, theme, view });
    const density = { 270: 640, 360: 480, 390: 443 };
    const strips = new Map();
    for (const phase of ['quiet', 'crowded']) {
        if (phase === 'crowded') {
            await command(`status working ${LONG_TASK}`);
            await command('changes');
            log('crowded: Working, a long task, three changed files');
        }
        for (const { width, theme, view } of cells) {
            sh(`wm density ${density[width]}`);
            sh(`cmd uimode night ${theme === 'dark' ? 'yes' : 'no'}`);
            await openAgent(view);
            const name = `${view}-${width}-1.0-${theme}`;
            const dir = join(evidence, 'native', phase);
            const dump = await capture(dir, name, phase === 'crowded');
            const box = header(dump);
            crop(join(dir, `${name}.png`), phase === 'quiet' ? box : strips.get(name).box, join(dir, `${name}-controls.png`));
            if (phase === 'quiet') { strips.set(name, { box }); continue; }
            const quiet = strips.get(name).box;
            const moved = Math.abs(box.titleRight - quiet.titleRight) > 2 || Math.abs(box.right - quiet.right) > 2;
            const changed = differing(join(evidence, 'native', 'quiet', `${name}-controls.png`), join(dir, `${name}-controls.png`));
            const verdict = moved ? `DEFECT ${name}: the header controls moved (title button ends at ${box.titleRight}, was ${quiet.titleRight})`
                : changed > 0 ? `DEFECT ${name}: ${changed} px of the crowded row paint over the toggle, pane count or ⋮`
                    : `clean ${name}: the controls beside the title are untouched`;
            if (verdict.startsWith('DEFECT')) defects.push(verdict);
            log(verdict);
            // The button clips what it holds, and a node's bounds are clipped with it: anything reaching
            // its right edge (or pushed past it, bounds inverted) is cut there instead of fitting.
            const inside = dump.filter((node) => !/Open panes$/.test(labelsOf(node)[1]) && /text="[^"]+"|content-desc="[^"]+"/.test(node)
                && boundsOf(node)[0] >= box.titleLeft && boundsOf(node)[1] >= box.top && boundsOf(node)[3] <= box.bottom && boundsOf(node)[2] <= box.titleRight + 1);
            for (const node of inside) {
                const [l, , r] = boundsOf(node);
                if (l < r && r < box.titleRight - 2) continue;
                const cut = `DEFECT ${name}: "${labelsOf(node).join('').slice(0, 40)}" is cut by the title button's edge`;
                defects.push(cut);
                log(cut);
            }
        }
    }

    // Self-review cells: the narrowest phone and the largest text, crowded.
    for (const [width, font] of [['270', '1.0'], ['390', '2.0']]) {
        for (const view of ['chat', 'terminal']) {
            sh(`wm density ${density[width]}`); sh(`settings put system font_scale ${font}`); sh('cmd uimode night yes');
            await openAgent(view);
            await capture(join(evidence, 'native', 'crowded'), `${view}-${width}-${font}-dark`, true);
            log(`captured ${view}-${width}-${font}-dark`);
        }
    }
    sh('settings put system font_scale 1.0');

    const steps = `${JSON.stringify({
        target: { version: JSON.parse(readFileSync('package.json', 'utf8')).version },
        start: 'lab-id release APK freshly installed and paired to the chat fake lab; Claude 1 idle with the task "Umer" and no changes',
        steps: ['open Claude 1 in chat view, then terminal view, at 360 and 390 dp, dark and light', `set Claude 1 Working with the task "${LONG_TASK}" and leave three changed files in its folder`, 'open it again in every cell', 'open it at 270 dp and at font 2.0 at 390 dp'],
        result: 'in every crowded cell the task ends in an ellipsis inside the title, the agent status shows as a dot (its word only where the row has room), the changes count is a small icon and number, and the chat/terminal toggle, pane count and ⋮ are the same pixels as in the quiet header',
    }, null, 2)}\n`;
    writeFileSync(join(evidence, 'steps.json'), steps);
} finally {
    try { sh('wm size reset'); sh('wm density reset'); sh('settings put system font_scale 1.0'); sh('cmd uimode night no'); } catch { /* emulator gone */ }
    if (lab !== undefined && lab.exitCode === null) {
        lab.kill('SIGTERM');
        await new Promise((resolve) => { lab.once('exit', resolve); setTimeout(resolve, 10_000); });
    }
    await emu.stop?.();
    for (const defect of defects) log(defect);
    log(`done; defects: ${defects.length}`);
    process.exitCode = defects.length > 0 ? 1 : 0;
}
