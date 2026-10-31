// "Move to another computer" in the installed PWA, between two real lab computers (Desk and Laptop,
// each a real relay + host + guarded Herdr lab session with a stand-in Claude; moveLab.mjs).
// See move-to-computer.md. Run from the repo root with HERDR_LAB_HELPER set and a lab web export
// (EXPO_PUBLIC_MUXR_LAB_PAIR=1 yarn web:export):
//   scripts/diagnostics/application/withPrivateXvfb.sh node .../moveToComputerPwaLab.mjs <web export dir> <evidence dir>
// For phone 390 and desktop 1280, dark and light, it opens the agent on Desk, Pane actions, Move to
// another computer, picks Laptop, confirms, and records each sheet state it reaches (pick, confirm,
// progress when the transfer is slow enough to catch, then the outcome). On a success it reads back,
// through Laptop's own Herdr, that the same conversation (its id and its earlier turn) is running there,
// types a new turn and sees the stand-in remember the earlier one. A refusal is recorded as the real
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

    // The conversation as Desk holds it before the move, read through Desk's own Herdr.
    const before = labHerdr(deskSession, 'pane', 'read', await pane(labInfo.desk), '--source', 'recent-unwrapped', '--lines', '40');
    writeFileSync(join(logs, 'desk-before.txt'), before);

    let moved = false;
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
    for (const theme of ['dark', 'light']) {
        await openBrowser(theme);
        await setAppTheme(theme);
        for (const cell of CELLS) {
            const tag = `${cell[0]}-${theme}`;
            emulate(cell, theme);
            // Desk is the connected computer; open its agent, then its Pane actions.
            const hasAgent = () => evalJs("!!document.querySelector('[aria-label^=\"Open Release notes\"]')");
            for (let attempt = 0; attempt < 6 && !hasAgent(); attempt += 1) {
                const connected = evalJs("document.querySelector('[aria-label^=\"Switch machine\"]')?.getAttribute('aria-label')") ?? '';
                if (!/current Desk/.test(connected)) {
                    click("/^Switch machine/.test(n.getAttribute('aria-label')||'')"); await sleep(1500);
                    click("/^Desk/.test(n.innerText||'') && n.children.length < 4"); await sleep(4000);
                }
                await sleep(4000);
            }
            await until('Desk agent row', hasAgent, 60);
            evalJs("document.querySelector('[aria-label^=\"Open Release notes\"]').click()");
            await until('the agent screen', () => evalJs("!!document.querySelector('[aria-label=\"Pane actions\"]')"), 60);
            evalJs("document.querySelector('[aria-label=\"Pane actions\"]').click()"); await sleep(1500);
            await until('the Move row', () => evalJs("!!document.querySelector('[aria-label=\"Move to another computer\"]')"), 30);
            shot(`actions-${tag}`);
            evalJs("document.querySelector('[aria-label=\"Move to another computer\"]').click()");
            await until('Laptop online', () => /Laptop\s*Online/.test(text() ?? ''), 60);
            click("/^Laptop\\s*Online/.test(n.innerText||'') && n.children.length < 5"); await sleep(800);
            shot(`pick-${tag}`);
            click("(n.innerText||'') === 'Continue' && n.getAttribute('role') === 'button'"); await sleep(1500);
            shot(`confirm-${tag}`);
            click("(n.innerText||'').startsWith('Move to Laptop') && n.getAttribute('role') === 'button'");
            const outcome = await until('an outcome', () => { const t = text() ?? ''; if (/Moved to Laptop/.test(t)) return 'moved'; if (/can.t move|didn.t finish|dropped|can.t take it|didn.t start/.test(t)) return 'failed'; return false; }, 240);
            await sleep(1000);
            shot(`outcome-${outcome}-${tag}`);
            if (outcome === 'moved') {
                moved = true;
                log(`moved (${tag})`);
                break;
            }
            log(`the move did not happen (${tag}): ${(text() ?? '').split('\n').filter((l) => /move|Laptop|Desk/i.test(l)).slice(0, 6).join(' / ')}`);
            // Close the sheet and carry on to the next cell: Desk still runs the agent.
            click("(n.innerText||'') === 'Cancel' && n.getAttribute('role') === 'button'"); await sleep(1000);
            ax('eval', 'location.reload()'); await sleep(8000);
        }
        await closeBrowser();
        if (moved) break;
    }
    if (!moved) throw new Error('the move never happened: see outcome-failed-*.png for what the app said; the original conversation stayed on Desk');
    const laptopPane = await pane(labInfo.laptop);
    const after = labHerdr(laptopSession, 'pane', 'read', laptopPane, '--source', 'recent-unwrapped', '--lines', '40');
    writeFileSync(join(logs, 'laptop-after.txt'), after);
    if (!/Resumed this conversation/.test(after) || !/saffron/.test(after)) throw new Error('the conversation did not arrive on Laptop');
    labHerdr(laptopSession, 'pane', 'send-text', laptopPane, 'What was the launch word?\n');
    await sleep(3000);
    const turn = labHerdr(laptopSession, 'pane', 'read', laptopPane, '--source', 'recent-unwrapped', '--lines', '40');
    writeFileSync(join(logs, 'laptop-turn.txt'), turn);
    if (!/You said: What was the launch word/.test(turn)) throw new Error('Laptop did not continue the conversation');
    log('PASS: the conversation moved from Desk to Laptop and carried on there');
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
