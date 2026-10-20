// Real agent panes printing long canned output, paired to a native app, for scroll and Latest checks.
// See terminal-latest.md.
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { linkHerdrLab } from './scripts/diagnostics/application/linkHerdrLab.mjs';
import { requestLab } from './scripts/diagnostics/application/linkLabClient.mjs';
import { screenShift } from './apps/host/dist/agent/infrastructure/terminalManager.js';

const { EVIDENCE, SERIAL } = process.env;
if (!EVIDENCE) throw new Error('Set EVIDENCE to the run evidence directory');
const KINDS = (process.env.KINDS ?? 'opencode,claude,codex,pi,shell').split(',').filter(Boolean);
const LINES = Number(process.env.LINES ?? 400);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mark = (line) => {
    const stamped = `${new Date().toISOString()} lab: ${line}`;
    console.log(stamped);
    appendFileSync(join(EVIDENCE, 'lab-timeline.log'), `${stamped}\n`);
};
const run = (bin, args) => new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${bin} ${args[0]} exited ${code}`)));
});

// A canned-output fixture stands in for every model: each agent's provider points at it.
const stub = spawn(process.execPath, [new URL('./labStub.mjs', `file://${process.cwd()}/.agents/skills/done-done-verify-pockit/features/`).pathname],
    { env: { ...process.env, STUB_LPS: process.env.STUB_LPS ?? '15' }, stdio: ['ignore', 'pipe', 'inherit'] });
const stubUrl = await new Promise((resolve) => stub.stdout.on('data', (chunk) => {
    const port = /listening on (\d+)/.exec(String(chunk))?.[1];
    if (port) resolve(`http://127.0.0.1:${port}`);
}));

// The host's owner socket offers one native pairing and approves the device that takes it.
// A new offer drops the last one, which may have run out before the device took it.
let offering;
const mintNativePairing = async (path) => {
    if (offering && !offering.destroyed) { offering.destroy(); await sleep(500); }
    return new Promise((resolve, reject) => {
        const socket = offering = createConnection(path);
        let pending = '';
        socket.on('error', reject);
        socket.on('connect', () => socket.write('{"intent":{"kind":"native","authority":"control","personal":false}}\n'));
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

const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'latest-'));
const workdir = join(root, 'work');
mkdirSync(workdir);
writeFileSync(join(workdir, 'opencode.json'), JSON.stringify({
    provider: { lab: { npm: '@ai-sdk/openai-compatible', name: 'Lab', options: { baseURL: `${stubUrl}/v1`, apiKey: 'lab' }, models: { stub: { name: 'Stub' } } } },
    model: 'lab/stub', small_model: 'lab/stub',
}));
let lab;
try {
    lab = await linkHerdrLab(root, 'latest', undefined, (herdr, session) => {
        // The lab's panes run under its own HOME; each harness there is pointed at the fixture.
        const stateDir = process.env.FM_HERDR_LAB_STATE_DIR;
        const home = join(readFileSync(join(stateDir, `${session}.xdg-root`), 'utf8').trim(), 'home');
        const write = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
        write(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'haiku', apiKeyHelper: 'echo lab-fixture-key',
            env: { ANTHROPIC_BASE_URL: stubUrl, DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } }));
        write(join(home, '.claude', '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark',
            projects: { [workdir]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }));
        write(join(home, '.codex', 'config.toml'), `model = "stub"\nmodel_provider = "lab"\n\n[model_providers.lab]\nname = "Lab"\nbase_url = "${stubUrl}/v1"\nwire_api = "responses"\n\n[projects."${workdir}"]\ntrust_level = "trusted"\n`);
        write(join(home, '.pi', 'agent', 'models.json'), JSON.stringify({ providers: { lab: { baseUrl: `${stubUrl}/v1`, api: 'openai-completions',
            apiKey: 'lab', models: [{ id: 'stub', name: 'Stub' }] } } }));
        write(join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({ defaultProvider: 'lab', defaultModel: 'stub' }));
    });
    const request = (type, params) => requestLab(lab.link, type, params);
    mark(`herdr session ${lab.session}`);
    const panes = {};
    for (const kind of KINDS) {
        const started = await request('session.start', { cwd: workdir, kind, label: `Umer ${kind}` });
        panes[kind] = started.info;
        mark(`${kind} started`);
    }
    const prompt = `Without using any tools, print the lines MARK-1 to MARK-${LINES}, one per line, each followed by a short sentence about the sea.`;
    const commands = {
        // The native app pairs as a control device of this lab's computer.
        pair: async () => {
            const pairing = await mintNativePairing(join(root, 'host', 'pair.sock'));
            const link = `muxr://pair#${pairing.code}`;
            if (SERIAL) {
                await run('adb', ['-s', SERIAL, 'reverse', `tcp:${lab.port}`, `tcp:${lab.port}`]);
                await run('adb', ['-s', SERIAL, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${link}'`, process.env.APP_ID ?? 'com.trymuxr.app']);
                mark('pairing link opened on the device; tap Pair');
            } else {
                writeFileSync(join(root, 'pair-link'), link, { mode: 0o600 });
                mark(`pairing link written to ${join(root, 'pair-link')}`);
            }
        },
        // What each pane shows now, saved next to the evidence.
        look: async (which = 'all') => {
            for (const kind of which === 'all' ? KINDS : [which]) {
                writeFileSync(join(EVIDENCE, `look-${kind}.txt`), lab.herdr(['pane', 'read', panes[kind].paneId, '--source', 'visible']));
            }
            mark(`looked at ${which}`);
        },
        // Long output in one pane (or all of them); a shell gets a loop instead of a prompt.
        stream: async (which = 'all') => {
            for (const kind of which === 'all' ? KINDS : [which]) {
                if (kind === 'shell') {
                    lab.herdr(['pane', 'send-text', panes.shell.paneId,
                        `for i in $(seq 1 ${LINES}); do echo "MARK-$i The tide pulls the sand back out."; sleep 0.06; done\n`]);
                } else {
                    await request('session.prompt', { sessionId: panes[kind].id, text: prompt });
                }
                mark(`${kind} streaming ${LINES} lines`);
            }
        },
        // A phone's drag over the real terminal stream, paced the way the app's
        // scroll gate paces it (one scroll in flight until a frame comes back or 250 ms pass),
        // then Latest. Logs the top MARK the pane shows over time to drag-<kind>.log.
        drag: async (kind = 'claude', rows = '60', ms = '2000') => {
            // A program started in a shell pane turns its route into an agent's.
            const listed = await request('session.list', {});
            const route = (Array.isArray(listed) ? listed : listed.sessions ?? []).find((session) => session.paneId === panes[kind].paneId)?.id ?? panes[kind].id;
            const stream = await lab.link.stream('terminal', { requestId: `drag-${Date.now()}`, sessionId: route,
                channel: `tm_drag_${Date.now().toString(36)}`, cols: 40, rows: 30, takeover: true });
            const t0 = Date.now();
            const lines = [];
            const log = (what) => lines.push(`${String(Date.now() - t0).padStart(6)} ${what}`);
            let inFlight = false;
            let sentAt = 0;
            let pending = 0;
            let frames = 0;
            let bottom;
            let rest = '';
            stream.onData = (chunk) => {
                const all = (rest + Buffer.from(chunk).toString('utf8')).split('\n');
                rest = all.pop();
                for (const line of all) {
                    if (line.includes('"terminal.frame"')) { frames++; inFlight = false; }
                    if (line.startsWith('{"type":"result"')) log(`attach ${line.slice(0, 200)}`);
                    const state = /"terminal\.bottom-state".*"state":"(\w[\w-]*)"/.exec(line)?.[1];
                    if (state) { bottom = state; log(`bottom-state ${state}`); }
                }
            };
            stream.onEnd = (error) => log(`stream ended ${error ?? ''}`);
            const send = (frame) => stream.write(`${JSON.stringify(frame)}\n`).catch((error) => log(`send failed ${error.message}`));
            const top = async () => {
                const text = await new Promise((resolve) => execFile(lab.wrapper, ['pane', 'read', panes[kind].paneId, '--source', 'visible'],
                    { encoding: 'utf8' }, (error, out) => resolve(error ? '' : out)));
                const marks = [...text.matchAll(/^\s*MARK-(\d+)/gm)].map((m) => Number(m[1]));
                return { first: marks[0], last: marks.at(-1), text };
            };
            // Rows the view has moved back since the drag began, summed sample to sample.
            let back = 0;
            let seen;
            let sampling = true;
            const samples = (async () => {
                while (sampling) {
                    const at = await top();
                    if (seen !== undefined && at.text !== '') back += screenShift(seen, at.text) ?? 0;
                    if (at.text !== '') seen = at.text;
                    log(`view ${at.first}..${at.last} back=${back} frames=${frames}`);
                    await sleep(150);
                }
            })();
            await sleep(1500);
            const total = Number(rows);
            const fingerStart = Date.now();
            for (let sent = 0; sent < total;) {
                const due = Math.min(total, Math.round((Date.now() - fingerStart) / Number(ms) * total));
                pending += due - sent; sent = due;
                // The app's scroll gate also lets go of a scroll no frame answered after 250 ms.
                if (inFlight && Date.now() - sentAt >= 250) inFlight = false;
                if (!inFlight && pending > 0) { inFlight = true; sentAt = Date.now(); send({ type: 'terminal.scroll', direction: 'up', lines: pending, column: 20, row: 15 }); log(`finger ${sent}/${total} sent ${pending}`); pending = 0; }
                await sleep(16);
            }
            log('finger up');
            await sleep(3000);
            log(process.env.LATEST_KEY ? 'latest key' : 'latest');
            if (process.env.LATEST_KEY) send({ type: 'terminal.input', bytes: Buffer.from(JSON.parse(`"${process.env.LATEST_KEY}"`)).toString('base64') });
            else send({ type: 'terminal.bottom', requestId: 'drag-bottom' });
            await sleep(4000);
            sampling = false;
            await samples;
            stream.end();
            writeFileSync(join(EVIDENCE, `drag-${kind}.log`), `${lines.join('\n')}\n`);
            mark(`drag ${kind} ${rows} rows over ${ms} ms logged (bottom ${bottom ?? 'n/a'})`);
        },
    };
    mark(`ready: ${KINDS.join(', ')}; enter: pair | stream [kind|all] | look [kind|all] | drag [kind rows ms] | quit`);
    const input = createInterface({ input: process.stdin });
    for await (const line of input) {
        const [name, ...args] = line.trim().split(/\s+/);
        if (name === 'quit') break;
        if (!(name in commands)) { console.error('commands: pair | stream [kind|all] | look [kind|all] | drag [kind rows ms] | quit'); continue; }
        await commands[name](...args).catch((error) => mark(`${name} failed: ${error.message}`));
    }
} finally {
    await lab?.stop();
    stub.kill();
    process.stdin.destroy();
}
