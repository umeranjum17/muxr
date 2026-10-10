// Real agent panes printing long canned output, paired to a native app, for scroll and Latest checks.
// See terminal-latest.md.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { linkHerdrLab } from './scripts/diagnostics/application/linkHerdrLab.mjs';
import { requestLab } from './scripts/diagnostics/application/linkLabClient.mjs';

const { EVIDENCE, SERIAL } = process.env;
if (!EVIDENCE) throw new Error('Set EVIDENCE to the run evidence directory');
const KINDS = (process.env.KINDS ?? 'opencode,claude,codex,pi,shell').split(',');
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
const stub = spawn(process.execPath, [new URL('./labStub.mjs', `file://${process.cwd()}/.agents/skills/verify-muxr/features/`).pathname],
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
    lab = await linkHerdrLab(root, 'latest', undefined, () => {
        // The lab's panes run under its own HOME; each harness there is pointed at the fixture.
        const stateDir = process.env.FM_HERDR_LAB_STATE_DIR;
        const pointer = readdirSync(stateDir).filter((file) => file.endsWith('.xdg-root')).map((file) => join(stateDir, file))
            .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
        const home = join(readFileSync(pointer, 'utf8').trim(), 'home');
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
    };
    mark(`ready: ${KINDS.join(', ')}; enter: pair | stream [kind|all] | look [kind|all] | quit`);
    const input = createInterface({ input: process.stdin });
    for await (const line of input) {
        const [name, ...args] = line.trim().split(/\s+/);
        if (name === 'quit') break;
        if (!(name in commands)) { console.error('commands: pair | stream [kind|all] | look [kind|all] | quit'); continue; }
        await commands[name](...args).catch((error) => mark(`${name} failed: ${error.message}`));
    }
} finally {
    await lab?.stop();
    stub.kill();
    process.stdin.destroy();
}
