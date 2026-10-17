// A real Herdr lab and OpenCode for the keyboard row floor, paired to a native app.
//
// Sub-features (proof criteria):
// - floor-keyboard tapping the prompt box on a 270 dp phone opens the keyboard and the pane keeps at least 24 rows in Herdr; OpenCode stays up.
// - floor-reply a prompt typed with the keyboard open reaches OpenCode, which answers from opencode-go/muse-spark-1.3-contributor.
// - floor-follow, floor-pan and floor-whole-rows: their criteria are in the header of apps/mobile/sources/terminal/application/terminalPan.ts; steps 5-7 drive them.
// - floor-roomy on a 393 dp-class screen nothing changes when the grid already holds 24 rows or more.
// - floor-pwa the same in the installed PWA.
//
// Why: OpenCode 1.18 and 1.19 die with a bun panic (`Illegal instruction (core dumped)`) on a short grid, and the keyboard on the 270 dp reference phone leaves room for 7; with the floor it keeps running and answers.
//
// Preconditions:
// - `yarn build`, and a release APK from `node perf/buildPrApk.mjs <out>` on an
//   owned emulator SERIAL at 1080x2376, density 640 (270 x 594 dp). A real Herdr
//   lab (HERDR_LAB_HELPER, FM_HERDR_LAB_STATE_DIR).
// - OpenCode: the lab pane's mise shim installs the latest into the lab's own
//   data dir (1.19.0 crashes the same way as 1.18.25).
// - For floor-reply, an OpenCode Go key in a 0600 file, GO_KEY_FILE. The lab
//   types it into OpenCode's own `opencode auth login` in a lab pane; it is never
//   printed, and the phone never shows it. Without it the check still proves the
//   floor and the crash; the reply needs the key.
//
// Drive it (from the repo root, in its own shell):
// 1. mkdir -p "$EVIDENCE", then
//    SERIAL=<serial> EVIDENCE=$EVIDENCE GO_KEY_FILE=<file> node --input-type=module -e "$(< .agents/skills/verify-pockit/features/terminalFloorLab.mjs)"
//    Keep stdin attached. It prints the folder OpenCode should work in.
// 2. `signin`, then `pair` and tap `Pair` on the phone.
// 3. On the phone: New agent -> OpenCode -> that folder -> Start. Wait for
//    OpenCode's screen; its status line names the model.
// 4. Start a screen recording, then enter `kbd`: the lab taps the prompt box,
//    waits for the keyboard and reads the open pane's rows from Herdr. It writes
//    `PASS the open pane holds >= 24 rows and did not crash` (or `FAIL ...`) to
//    $EVIDENCE/lab-timeline.log and each pane's last screen next to it.
// 5. Type `What does calc.py do?` and send, keyboard still up. Capture the reply
//    above OpenCode's prompt. `check` again afterwards.
// 6. Close the keyboard, set Settings -> Appearance -> Text size -> 20 pt (on
//    native, Terminal controls -> Appearance zooms the same setting) and capture;
//    `pan down` (quick drags inside the visible box) and capture the top rows;
//    `pan up` and capture the bottom ones.
// 7. Repeat at density 420 (`adb shell wm density 420`), and in light and dark.
//    For floor-whole-rows, a plain shell pane is enough (no OpenCode, no key):
//    in a lab workspace run `seq -f 'row %g of the notes for Umer' 1 100 > notes.txt; nvim -u NONE notes.txt`,
//    open that pane, and look at the box's bottom edge at 270 and 393 dp, font 1.0
//    and 2.0 against terminalPan.ts's floor-whole-rows criterion.
// 8. `quit` stops the panes, the host and the relay, and tears the lab down.
//
// Before #844 the same `kbd` read 7 rows and CRASHED on a 270 dp phone. Before
// the pan, a main build showed only OpenCode's prompt and status with the
// keyboard up, and at font 20 its top rows could not be reached.
//
// Gotchas:
// - The floor is MIN_TERMINAL_ROWS / MIN_TERMINAL_CELLS in
//   apps/mobile/sources/terminal/domain/terminalFloor.ts. The probe behind it, a
//   bare pty: at 37 columns OpenCode survives 22 rows and panics at every height
//   from 21 down to 12. Narrower needs more: 31 x 22, 29 x 24, 26 x 24 and 22 x 24
//   panic; 31 x 26, 29 x 32, 26 x 30 and 22 x 40 live. Those heights move with
//   content: 1.x dies whenever its home screen is taller than the grid, so a long
//   folder path or its two-line "/update to upgrade to OpenCode 2.0" notice crashes
//   37 x 24 and 37 x 27 too. OpenCode 2.x does not crash at any of these sizes.
// - Herdr's `pane list` gives a pane's rows as `scroll.viewport_rows`.
// - The key must stay out of every recording and screenshot: stop recording
//   before `signin`, and never `pane read` the sign-in pane.
// - At 270 dp the New agent Folder field scrolls under the sticky Start button;
//   scroll on until it clears, or the tap lands on `Start OpenCode in ~`.
// - An agent the phone starts in a folder under /home/user meets mise's
//   "config files are not trusted" prompt (the lab HOME is not the real one);
//   `mise trust ~/.config/mise/config.toml` in a lab pane records the trust in
//   the lab's own state only. Do it before `signin` too, or the sign-in waits
//   on that prompt and times out.
// - On web at 270 dp, typing used to throw React error #185 (maximum update
//   depth) into "Something went wrong". Not the floor: the per-keystroke draft
//   write is gone (see web-prompt-typing.md). If it shows again, Retry recovers.
// - Android's font scale does not change the terminal font; only Text size does.
// - On web, emulate the phone at DPR 1: at DPR 4 xterm draws giant glyphs. The
//   PWA's service worker keeps a stale bundle across a rebuild: unregister it and
//   clear its caches before reloading.
// - The terminal screen is dark in the light theme too.
// - On the PWA, run Chromium with --force-device-scale-factor=2 (and
//   --ozone-platform=x11 on a private Xvfb, since the distro wrapper otherwise
//   picks Wayland). A window whose real DPR differs from the emulated one keeps
//   xterm's WebGL canvas at the old DPR, so every row paints about 12% taller than
//   its cell and the box looks cut where it is not. The export keeps the same
//   index-*.js name across a rebuild, so clear the HTTP cache too
//   (Network.clearBrowserCache over CDP), not only the service worker.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { linkHerdrLab } from './scripts/diagnostics/application/linkHerdrLab.mjs';

const { EVIDENCE, SERIAL, GO_KEY_FILE } = process.env;
if (!EVIDENCE) throw new Error('Set EVIDENCE to the run evidence directory');
const MODEL = process.env.MODEL ?? 'opencode-go/muse-spark-1.3-contributor';
// The floor the app holds, read from the app so the check cannot drift from it.
const FLOOR = Number(/const MIN_TERMINAL_ROWS = (\d+);/.exec(readFileSync('apps/mobile/sources/terminal/domain/terminalFloor.ts', 'utf8'))?.[1]);
const CRASHED = /Illegal instruction|bun\.report|panic\(main thread\)|command not found/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mark = (line) => {
    const stamped = `${new Date().toISOString()} lab: ${line}`;
    console.log(stamped);
    appendFileSync(join(EVIDENCE, 'lab-timeline.log'), `${stamped}\n`);
};
const adb = (...args) => execFileSync('adb', ['-s', SERIAL, ...args], { encoding: 'utf8' });

// The host's owner socket offers one pairing and approves the device that takes it.
let offering;
const mintPairing = async (path, kind) => {
    if (offering && !offering.destroyed) { offering.destroy(); await sleep(500); }
    return new Promise((resolve, reject) => {
        const socket = offering = createConnection(path);
        let pending = '';
        socket.on('error', reject);
        socket.on('connect', () => socket.write(`${JSON.stringify({ intent: { kind, authority: 'control', personal: false } })}\n`));
        socket.on('data', (chunk) => {
            pending += String(chunk);
            for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
                const event = JSON.parse(pending.slice(0, end));
                pending = pending.slice(end + 1);
                if (event.offer) resolve({ code: event.offer.text });
                if (event.approval) { socket.write('{"yes":true}\n'); mark('device paired'); }
                if (event.error) reject(new Error(event.error));
            }
        });
    });
};

const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'floor-'));
const workdir = join(root, 'calc');
mkdirSync(workdir);
writeFileSync(join(workdir, 'calc.py'), 'def add(a, b):\n    return a + b\n');
// The model the reply must come from; OpenCode names it in its own status line.
writeFileSync(join(workdir, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: MODEL }));
let lab;
try {
    lab = await linkHerdrLab(root, 'kf');
    mark(`herdr session ${lab.session}; floor ${FLOOR} rows; OpenCode works in ${workdir}`);
    const panes = () => JSON.parse(lab.herdr(['pane', 'list'])).result.panes;
    const commands = {
        pair: async () => {
            const pairing = await mintPairing(join(root, 'host', 'pair.sock'), 'native');
            adb('reverse', `tcp:${lab.port}`, `tcp:${lab.port}`);
            adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'muxr://pair#${pairing.code}'`, process.env.APP_ID ?? 'com.trymuxr.app');
            mark('pairing link opened on the device; tap Pair');
        },
        // An installed PWA pairs with `window.__MUXR_LAB_PAIR__(<link>)` (lab-browser-pairing.md).
        browser: async () => {
            const pairing = await mintPairing(join(root, 'host', 'pair.sock'), 'browser');
            writeFileSync(join(root, 'browser-link'), pairing.code, { mode: 0o600 });
            mark(`browser link written to ${join(root, 'browser-link')}; relay port ${lab.port}`);
        },
        // OpenCode's own sign-in, in the lab's account home. The key goes from
        // its file to the pane; it is never printed, logged or shown on the phone.
        signin: async () => {
            if (!GO_KEY_FILE) throw new Error('Set GO_KEY_FILE');
            const { workspace, root_pane: { pane_id: pane } } = JSON.parse(lab.herdr(['workspace', 'create', '--cwd', workdir, '--label', 'signin', '--no-focus'])).result;
            const send = (text) => lab.herdr(['pane', 'send-text', pane, text]);
            const keys = (key) => lab.herdr(['pane', 'send-keys', pane, key]);
            // Each step waits for OpenCode's own prompt (the first run may still be
            // installing it), so the key can only ever land in its masked field.
            const until = async (prompt) => {
                for (let tries = 0; !lab.herdr(['pane', 'read', pane, '--source', 'visible']).includes(prompt); tries++) {
                    if (tries === 120) throw new Error(`OpenCode never asked "${prompt}"`);
                    await sleep(1000);
                }
            };
            try {
                send('opencode auth login\n');
                await until('Select provider');
                send('OpenCode Go');
                await until('(1 match)');
                keys('enter');
                await until('Enter your API key');
                send(readFileSync(GO_KEY_FILE, 'utf8').trim());
                keys('enter');
                await sleep(4000);
                send('exit\n');
                await sleep(1000);
            } finally {
                // The pane held the key; nothing may read it later.
                try { lab.herdr(['workspace', 'close', workspace.workspace_id]); } catch { /* the shell's exit closed it */ }
            }
            mark('signed in through opencode auth login');
        },
        // The grid Herdr holds for the pane the phone is on, and whether the agent in it is still up.
        check: async () => {
            const report = panes().filter((pane) => pane.focused).map((pane) => {
                const screen = lab.herdr(['pane', 'read', pane.pane_id, '--source', 'recent', '--lines', '60']);
                return { pane: pane.pane_id, rows: pane.scroll.viewport_rows, crashed: CRASHED.test(screen), screen };
            });
            for (const { pane, rows, crashed, screen } of report) {
                writeFileSync(join(EVIDENCE, `screen-${pane.replace(/\W/g, '_')}.txt`), screen);
                mark(`${pane}: ${rows} rows, ${crashed ? 'CRASHED' : 'alive'}`);
            }
            const ok = report.length > 0 && report.every(({ rows, crashed }) => rows >= FLOOR && !crashed);
            mark(ok ? `PASS the open pane holds >= ${FLOOR} rows and did not crash` : `FAIL the open pane is under ${FLOOR} rows or crashed`);
            return ok;
        },
        // Drag the terminal: `pan down` reaches the grid's top rows, `pan up` its bottom ones.
        pan: async (direction = 'down') => {
            const dump = adb('exec-out', 'uiautomator', 'dump', '/dev/tty');
            const nodes = [...dump.matchAll(/content-desc="([^"]*)"[^>]*bounds="\[\d+,(\d+)\]\[\d+,(\d+)\]"/g)];
            const find = (pattern) => nodes.find((match) => pattern.test(match[1]));
            // The surface is taller than its box; drag inside what shows, between the header and the tabs row.
            const header = find(/^Back$/);
            const tabs = find(/^Current tab /);
            if (!header || !tabs) throw new Error('no terminal on screen; open the agent first');
            const [top, bottom] = [Number(header[3]) + 40, Number(tabs[2]) - 40];
            const [from, to] = direction === 'up' ? [bottom, top] : [top, bottom];
            // A slow drag pans about a row; a quick one carries the whole stroke.
            for (let stroke = 0; stroke < 3; stroke++) adb('shell', 'input', 'swipe', '540', String(from), '540', String(to), '250');
            mark(`dragged the terminal ${direction}`);
        },
        // The journey: tap the prompt box so the keyboard opens, let it settle, check.
        kbd: async () => {
            const dump = adb('exec-out', 'uiautomator', 'dump', '/dev/tty');
            const bounds = /content-desc="Prompt"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(dump);
            if (!bounds) throw new Error('no Prompt field on screen; open the agent first');
            const [x1, y1, x2, y2] = bounds.slice(1).map(Number);
            adb('shell', 'input', 'tap', String((x1 + x2) >> 1), String((y1 + y2) >> 1));
            mark('tapped the prompt box');
            await sleep(5000);
            if (!/mInputShown=true|mIsInputViewShown=true/.test(adb('shell', 'dumpsys', 'input_method'))) {
                mark('FAIL the keyboard did not open, so the floor was not exercised');
                return false;
            }
            return commands.check();
        },
    };
    mark('ready; enter: pair | browser | signin | kbd | check | pan [down|up] | quit');
    const input = createInterface({ input: process.stdin });
    for await (const line of input) {
        const [name, ...args] = line.trim().split(/\s+/);
        if (name === 'quit') break;
        if (!(name in commands)) { console.error('commands: pair | browser | signin | kbd | check | pan [down|up] | quit'); continue; }
        await commands[name](...args).catch((error) => mark(`${name} failed: ${error.message}`));
    }
} finally {
    await lab?.stop();
    process.stdin.destroy();
}
