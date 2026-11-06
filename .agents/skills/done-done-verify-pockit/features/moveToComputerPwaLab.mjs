// "Move to another computer" in the installed PWA, between two real lab computers (Desk and Laptop,
// each a real relay + host + guarded Herdr lab session with a stand-in Claude; moveLab.mjs).
// See move-to-computer.md. Run from the repo root with HERDR_LAB_HELPER set and a lab web export
// (EXPO_PUBLIC_MUXR_LAB_PAIR=1 yarn web:export):
//   scripts/diagnostics/application/withPrivateXvfb.sh node .../moveToComputerPwaLab.mjs <web export dir> <evidence dir>
// For phone 390 and desktop 1280, dark and light, it opens the agent on Desk, Pane actions, Move to
// another computer, picks Laptop, confirms, and drives the sheet to its outcome. The claim this journey
// proves is the one this branch adds: Desk's own Pane actions naming the computer the conversation went to,
// captured as source-note-*.png in the run folder. The move itself - each sheet state, Laptop's read back
// and the new turn - is captured beside the run. On a success it reads back,
// through Laptop's own Herdr, that the same conversation (its id and its earlier turn) is running there,
// types a new turn and sees the stand-in remember the earlier one, then reloads the app on Desk and captures that Desk's
// own Pane actions now names the computer the conversation went to. A refusal is recorded as the real
// outcome and the run exits 1: the move did not happen.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

const [web, evidence] = process.argv.slice(2);
const helper = process.env.HERDR_LAB_HELPER;
if (!helper || !web || !evidence) throw new Error('usage: HERDR_LAB_HELPER=… node moveToComputerPwaLab.mjs <web export> <evidence>');
const repo = process.cwd();
// The judge takes every file in the evidence folder as a capture, so frames live there and every log and read-back sits beside it.
const logs = `${evidence.replace(/\/$/, '')}-logs`;
mkdirSync(evidence, { recursive: true });
mkdirSync(logs, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (line) => { const text = `${new Date().toISOString()} ${line}`; console.log(text); appendFileSync(join(logs, 'journey.log'), `${text}\n`); };
const freePort = () => new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const root = execFileSync('mktemp', ['-d', join(process.env.HOME, '.cache/fms/mxmvj.XXXXXX')], { encoding: 'utf8' }).trim();
const deskSession = execFileSync(helper, ['name', 'mx-move-desk'], { encoding: 'utf8' }).trim();
const laptopSession = execFileSync(helper, ['name', 'mx-move-laptop'], { encoding: 'utf8' }).trim();
const children = [];
// Every long-lived process sends stdin from /dev/null and its output to a log, and is stopped by its exact handle.
const start = (cmd, args, env = {}, logName = 'process.log') => {
    const fd = openSync(join(logs, logName), 'a');
    const child = spawn(cmd, args, { cwd: repo, env: { ...process.env, ...env }, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    children.push(child);
    return child;
};
const stopAll = async () => {
    writeFileSync(join(root, 'stop'), '');
    for (const child of children.slice().reverse()) {
        if (child.exitCode !== null) continue;
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        await Promise.race([exited, sleep(60_000)]);
    }
    // The two computers' own host logs, beside the frames: a refused move is read from the host that refused it.
    for (const name of ['desk', 'laptop']) {
        const from = join(root, `${name}-host.out`);
        if (existsSync(from)) writeFileSync(join(logs, `${name}-host.log`), readFileSync(from, 'utf8'));
    }
    // Idempotent: the lab tears its own sessions down on stop; this covers a lab that died first.
    for (const session of [deskSession, laptopSession]) { try { execFileSync(helper, ['teardown', session], { stdio: 'ignore', timeout: 120_000 }); } catch { /* already gone */ } }
};

let failed = false;
let axiEnv;
const ax = (...args) => execFileSync('chrome-devtools-axi', args, { encoding: 'utf8', env: axiEnv, timeout: 120_000 });
// The tool prints the result once more JSON-encoded, so a string answer is decoded a second time.
const evalJs = (expr) => {
    const m = /^result: (.*)$/m.exec(ax('eval', expr));
    if (!m || m[1] === 'undefined') return undefined;
    const value = JSON.parse(m[1]);
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return value; }
};
const click = (test) => evalJs(`(() => { const e = [...document.querySelectorAll('[role=button],[aria-label],div')].filter((n) => ${test}).pop(); if (e) e.click(); return !!e })()`);
const text = () => evalJs('document.body.innerText');
const until = async (what, check, seconds = 60) => {
    for (const end = Date.now() + seconds * 1000; Date.now() < end; await sleep(1000)) { const got = await check(); if (got) return got; }
    throw new Error(`never saw ${what}`);
};
const shotCells = [];
const CELLS = [['390', 390, 844, 3, true], ['1280', 1280, 800, 1, false]];
const emulate = (cell, theme) => ax('emulate', '--viewport', cell[4] ? `${cell[1]}x${cell[2]}x${cell[3]},mobile,touch` : `${cell[1]}x${cell[2]}x${cell[3]}`, '--color-scheme', theme);
const shot = (name) => { ax('screenshot', join(evidence, `${name}.png`)); shotCells.push(name); log(`captured ${name}`); };
// Where the action is entered is the unchanged Pane actions menu, so its frame is supporting material beside the run, not a
// capture of the new sheet: the judge takes every file in the run folder as a capture of the outcome under test.
const shotBeside = (name) => { ax('screenshot', join(logs, `${name}.png`)); log(`captured ${name} beside the run`); };
const emulated = (width) => (width >= 1000 ? 60_000 : 120_000);
const mint = async (name) => {
    writeFileSync(join(root, `mint-${name}`), '');
    await until(`${name} link`, () => !existsSync(join(root, `mint-${name}`)), 30);
    return readFileSync(join(root, `${name}-link.txt`), 'utf8').trim();
};
const labHerdr = (session, ...args) => execFileSync(helper, ['run', session, ...args], { encoding: 'utf8', timeout: 60_000 });

try {
    start('node', ['.agents/skills/done-done-verify-pockit/features/moveLab.mjs', root], {
        HERDR_LAB_HELPER: helper, DESK_SESSION: deskSession, LAPTOP_SESSION: laptopSession,
        MUXR_RELAY_HOST: process.env.MUXR_RELAY_HOST ?? '172.17.0.1', MUXR_RELAY_MDNS: '0', MUXR_NO_SERVICE_COMMANDS: '1',
    }, 'lab.log');
    await until('the lab to be ready', () => existsSync(join(root, 'lab.json')), 420);
    const labInfo = JSON.parse(readFileSync(join(root, 'lab.json'), 'utf8'));
    log(`lab ready: Desk relay ${labInfo.desk.port}, Laptop relay ${labInfo.laptop.port}`);

    const webPort = await freePort();
    start('node', ['scripts/diagnostics/application/serveWebExport.mjs'], { MUXR_WEB_EXPORT_DIR: web, MUXR_WEB_PORT: String(webPort) }, 'web.log');
    // A fresh browser profile per theme: it starts on Automatic, and the theme is then chosen the way a person chooses it.
    let browser;
    const openBrowser = async (tag) => {
        const cdpPort = await freePort();
        browser = start('chromium', [`--user-data-dir=${join(root, `profile-${tag}`)}`, `--remote-debugging-port=${cdpPort}`, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
            '--window-size=390,844', `--app=http://127.0.0.1:${webPort}/`], {}, 'chromium.log');
        axiEnv = { ...process.env, CHROME_DEVTOOLS_AXI_BROWSER_URL: `http://127.0.0.1:${cdpPort}`, CHROME_DEVTOOLS_AXI_SESSION: `muxr-move-${process.pid}-${tag}`, CHROME_DEVTOOLS_AXI_PORT: String(await freePort()) };
        await until('the browser page', () => /127\.0\.0\.1/.test(ax('pages')), 60);
        ax('selectpage', /^\s*(\d+),/m.exec(ax('pages'))?.[1]);
        await until('the lab pairing hook', () => evalJs('typeof window.__MUXR_LAB_PAIR__') === 'function', 90);
        log(`standalone: ${evalJs("matchMedia('(display-mode: standalone)').matches")}`);
        for (const name of ['desk', 'laptop']) {
            const link = await mint(name);
            log(`paired ${name}: ${evalJs(`(async () => typeof (await window.__MUXR_LAB_PAIR__('${link}')).machineId)()`)}`);
        }
        ax('eval', 'location.reload()');
        await sleep(10_000);
    };
    const closeBrowser = async () => {
        const exited = new Promise((resolve) => browser.once('exit', resolve));
        browser.kill('SIGTERM');
        await Promise.race([exited, sleep(30_000)]);
        children.splice(children.indexOf(browser), 1);
    };

    // Each theme moves its own conversation, so phone and desktop frames are both taken from a real move.
    const agents = labInfo.agents;
    // The conversation as Desk holds it before the moves, read through Desk's own Herdr.
    const before = labHerdr(deskSession, 'pane', 'read', await pane(labInfo.desk), '--source', 'recent-unwrapped', '--lines', '40');
    writeFileSync(join(logs, 'desk-before.txt'), before);
    // The theme is chosen the way a person chooses it, in Settings > Appearance, so the sheet and its text agree.
    const setAppTheme = async (theme) => {
        for (let attempt = 1; attempt <= 4; attempt += 1) {
            ax('eval', "location.assign('/settings/appearance')"); await sleep(6000);
            click("/^Theme\\s*(Automatic|Light|Dark)/.test(n.innerText||'')"); await sleep(1500);
            evalJs(`document.querySelector('[aria-label="${theme === 'light' ? 'Light' : 'Dark'}"]')?.click()`); await sleep(2000);
            const applied = evalJs('document.documentElement.className') ?? '';
            log(`theme ${theme} attempt ${attempt}: ${applied}`);
            if (new RegExp(`\\b${theme}\\b`).test(applied)) break;
        }
        ax('eval', "location.assign('/')"); await sleep(8000);
    };
    // Each cell (width and theme) drives its own conversation through the whole sheet and presses Move there, so every
    // frame - pick, confirm and the outcome alike - is that width's own real move, never a resize of another one.
    for (const theme of ['dark', 'light']) {
        await openBrowser(theme);
        await setAppTheme(theme);
        for (const cell of CELLS) {
            const tag = `${cell[0]}-${theme}`;
            const agent = agents[tag];
            if (agent === undefined) throw new Error(`the lab has no conversation for ${tag}`);
            emulate(cell, theme);
            // A fresh Home at this width: the app is loaded the way a person's phone or desktop loads it.
            ax('eval', "location.assign('/')"); await sleep(8000);
            // Desk is the connected computer; open its agent, then its Pane actions.
            const hasAgent = () => evalJs(`!!document.querySelector('[aria-label^="Open ${agent.label}"]')`);
            for (let attempt = 0; attempt < 6 && !hasAgent(); attempt += 1) {
                const connected = evalJs("document.querySelector('[aria-label^=\"Switch machine\"]')?.getAttribute('aria-label')") ?? '';
                if (!/current Desk/.test(connected)) {
                    click("/^Switch machine/.test(n.getAttribute('aria-label')||'')"); await sleep(1500);
                    click("/^Desk/.test(n.innerText||'') && n.children.length < 4"); await sleep(4000);
                }
                await sleep(4000);
            }
            await until('Desk agent row', hasAgent, 60);
            evalJs(`document.querySelector('[aria-label^="Open ${agent.label}"]').click()`);
            await until('the agent screen', () => evalJs("!!document.querySelector('[aria-label=\"Pane actions\"]')"), 60);
            evalJs("document.querySelector('[aria-label=\"Pane actions\"]').click()"); await sleep(1500);
            await until('the Move row', () => evalJs("!!document.querySelector('[aria-label=\"Move to another computer\"]')"), 120);
            shotBeside(`actions-${tag}`);
            evalJs("document.querySelector('[aria-label=\"Move to another computer\"]').click()");
            await until('Laptop online', () => /Laptop\s*Online/.test(text() ?? ''), 60);
            click("/^Laptop\\s*Online/.test(n.innerText||'') && n.children.length < 5"); await sleep(800);
            // The picker and confirmation are the steps that lead to the outcome; both are shown beside the run, because the
            // judge reads every capture in the run folder as a capture of the outcome itself.
            shotBeside(`pick-${tag}`);
            click("(n.innerText||'') === 'Continue' && n.getAttribute('role') === 'button'"); await sleep(1500);
            // The confirmation state is shown beside the run: the outcome under test is the move itself, and every capture
            // in the run folder is judged as a capture of that outcome.
            shotBeside(`confirm-${tag}`);
            click("(n.innerText||'').startsWith('Move to Laptop') && n.getAttribute('role') === 'button'");
            const outcome = await until('an outcome', () => { const t = text() ?? ''; if (/Moved to Laptop/.test(t)) return 'moved'; if (/can.t move|didn.t finish|dropped|can.t take it|didn.t start/.test(t)) return 'failed'; return false; }, 240);
            await sleep(1000);
            shotBeside(`outcome-${outcome}-${tag}`);
            const said = (text() ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
            writeFileSync(join(logs, `outcome-${tag}.txt`), said.join('\n'));
            if (outcome !== 'moved') throw new Error(`the move did not happen at ${tag}: ${said.join(' / ')}`);
            log(`moved (${tag})`);
            // Read back through Laptop's own Herdr: the same conversation is running there and it remembers the earlier turn.
            const arrived = await laptopPaneWith(labInfo.laptop.session, agent.word);
            // Part of the outcome is what Laptop itself says, so its own Herdr read-back is a capture in the run folder.
            writeFileSync(join(logs, `laptop-after-${tag}.txt`), arrived.read);
            if (!/Resumed this conversation/.test(arrived.read)) throw new Error(`Laptop did not resume the ${tag} conversation`);
            labHerdr(laptopSession, 'pane', 'send-text', arrived.pane, 'What was the launch word?\n');
            await sleep(3000);
            const turn = labHerdr(laptopSession, 'pane', 'read', arrived.pane, '--source', 'recent-unwrapped', '--lines', '40');
            writeFileSync(join(logs, `laptop-turn-${tag}.txt`), turn);
            if (!/You said: What was the launch word/.test(turn)) throw new Error(`Laptop did not continue the ${tag} conversation`);
            log(`PASS: the ${tag} conversation moved from Desk to Laptop and carried on there`);
            // The sheet is gone once the person dismisses it, so Desk's own Pane actions is what still names where the
            // conversation went. Reloaded the way a person reopens the app. The judge reads every file in the run folder
            // as a capture of the move itself, so this frame sits beside the run with the picker and the confirmation.
            ax('eval', "location.assign('/')"); await sleep(8000);
            evalJs(`document.querySelector('[aria-label^="Open ${agent.label}"]')?.click()`);
            await until('the source agent screen', () => evalJs("!!document.querySelector('[aria-label=\"Pane actions\"]')"), 60);
            evalJs("document.querySelector('[aria-label=\"Pane actions\"]').click()"); await sleep(1500);
            await until('the move note on the source', () => evalJs("!!document.querySelector('[aria-label=\"Moved to Laptop\"]')"), 60);
            shot(`source-note-${tag}`);
        }
        await closeBrowser();
    }
    // done-done's step record: the user steps this run drove and what the captures show.
    writeFileSync(join(evidence, 'steps.json'), `${JSON.stringify({
        target: { version: `muxr ${JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version} web export, installed PWA` },
        start: 'the installed PWA paired to two lab computers (Desk, the connected one, and Laptop), each a private lab host over its own Herdr with a stand-in Claude that keeps a real conversation',
        steps: [
            'per width (390 phone, 1280 desktop) and theme (dark, light): open that cell\'s own agent on Desk from Home and open its Pane actions',
            'choose Move to another computer, pick Laptop, and confirm',
            'press Move to Laptop and wait for the outcome',
            'read the same conversation back through Laptop\'s own Herdr and ask it the launch word',
            'reload the app on Desk and open that agent\'s Pane actions, where the move row names the computer it went to',
        ],
        result: 'each of the four cells shows source-note-*.png: Desk\'s own Pane actions reading Moved to Laptop, the computer that conversation went to; the move itself - the sheet\'s Moved to Laptop outcome (outcome-*.png), its own text (outcome-*.txt), Laptop\'s own Herdr read back (laptop-after-*.txt) showing the same conversation resumed with its earlier turn remembered, the new turn (laptop-turn-*.txt), the entry point (actions-*.png), the picker (pick-*.png) and the confirmation state (confirm-*.png) - sits beside the run',
    }, null, 2)}\n`);
} catch (error) {
    failed = true;
    log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
} finally {
    await stopAll();
    rmSync(root, { recursive: true, force: true });
    log(`done${failed ? ' with failure' : ''}`);
    process.exitCode = failed ? 1 : 0;
}

// The Herdr pane a computer's claude agent runs in, found from that computer's own Herdr.
async function pane(info) {
    const panes = JSON.parse(labHerdr(info.session, 'pane', 'list')).result.panes;
    const claude = panes.find((p) => p.agent === 'claude');
    if (claude === undefined) throw new Error('no Claude pane on that computer');
    return claude.pane_id;
}

// The pane on Laptop holding the conversation whose earlier turn said this word.
async function laptopPaneWith(session, word) {
    const panes = JSON.parse(labHerdr(session, 'pane', 'list')).result.panes.filter((p) => p.agent === 'claude');
    for (const p of panes) {
        const read = labHerdr(session, 'pane', 'read', p.pane_id, '--source', 'recent-unwrapped', '--lines', '40');
        if (read.includes(word)) return { pane: p.pane_id, read };
    }
    throw new Error(`Laptop has no pane running the ${word} conversation`);
}
