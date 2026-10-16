// A real OpenCode in a guarded Herdr lab that stops on its own permission box, paired to a native app.
// See opencode-permission-answers.md.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { linkHerdrLab } from './scripts/diagnostics/application/linkHerdrLab.mjs';
import { requestLab } from './scripts/diagnostics/application/linkLabClient.mjs';

const { EVIDENCE, SERIAL } = process.env;
if (!EVIDENCE) throw new Error('Set EVIDENCE to the run evidence directory');
const PROMPT = 'Read the file /etc/os-release and tell me the distro';
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

// A stand-in for the model (not a real one): its first answer to a turn calls OpenCode's
// read tool on /etc/os-release, outside the agent's folder, which raises OpenCode's own
// "Permission required · Access external directory" box. The tool result gets one line back.
const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
        if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"standin"}]}'); return; }
        const last = (JSON.parse(raw).messages ?? []).at(-1);
        const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: 'lab', object: 'chat.completion.chunk', created: 0, model: 'standin', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (last?.role === 'tool') {
            const distro = /PRETTY_NAME="?([^"\n]+)/.exec(typeof last.content === 'string' ? last.content : JSON.stringify(last.content))?.[1];
            chunk({ role: 'assistant', content: distro ? `The distro is ${distro}.` : 'I was not allowed to read that file.' });
            chunk({}, 'stop');
        } else {
            chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'read_1', type: 'function', function: { name: 'read', arguments: '{"filePath":"/etc/os-release"}' } }] });
            chunk({}, 'tool_calls');
        }
        res.end('data: [DONE]\n\n');
    });
});
const stubUrl = await new Promise((resolve) => stub.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${stub.address().port}`)));

// The host's owner socket offers one pairing (native app or browser) and approves the device that takes it.
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

const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'ocperm-'));
const workdir = join(root, 'distro-check');
mkdirSync(workdir);
writeFileSync(join(workdir, 'opencode.json'), JSON.stringify({
    provider: { lab: { npm: '@ai-sdk/openai-compatible', name: 'Lab', options: { baseURL: `${stubUrl}/v1`, apiKey: 'lab' }, models: { standin: { name: 'Lab stand-in' } } } },
    model: 'lab/standin', small_model: 'lab/standin', autoupdate: false,
}));
let lab;
try {
    lab = await linkHerdrLab(root, 'ocperm');
    const request = (type, params) => requestLab(lab.link, type, params);
    mark(`herdr session ${lab.session}`);
    let agent;
    const commands = {
        // `pair` opens a native pairing on SERIAL; `pair browser` writes a link for the PWA's lab hook.
        pair: async (kind = 'native') => {
            const pairing = await mintPairing(join(root, 'host', 'pair.sock'), kind);
            const link = kind === 'native' ? `muxr://pair#${pairing.code}` : pairing.code;
            if (SERIAL && kind === 'native') {
                await run('adb', ['-s', SERIAL, 'reverse', `tcp:${lab.port}`, `tcp:${lab.port}`]);
                await run('adb', ['-s', SERIAL, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${link}'`, process.env.APP_ID ?? 'com.trymuxr.app']);
                mark('pairing link opened on the device; tap Pair');
            } else {
                writeFileSync(join(root, 'pair-link'), link, { mode: 0o600 });
                mark(`pairing link written to ${join(root, 'pair-link')}`);
            }
        },
        // A fresh OpenCode each time: Allow always holds until OpenCode restarts.
        start: async () => {
            agent = (await request('session.start', { cwd: workdir, kind: 'opencode', label: 'Umer distro check' })).info;
            mark(`opencode started in ${agent.paneId}`);
        },
        ask: async () => {
            await request('session.prompt', { sessionId: agent.id, text: PROMPT });
            mark(`asked: ${PROMPT}`);
        },
        // The pane as Herdr reads it, its status, and the colour read the chips parse.
        look: async (name = 'look') => {
            writeFileSync(join(EVIDENCE, `${name}.txt`), lab.herdr(['pane', 'read', agent.paneId, '--source', 'visible']));
            writeFileSync(join(EVIDENCE, `${name}.ansi`), lab.herdr(['pane', 'read', agent.paneId, '--source', 'visible', '--format', 'ansi']));
            mark(`${name}: ${/"agent_status":"(\w+)"/.exec(lab.herdr(['pane', 'get', agent.paneId]))?.[1]}`);
        },
    };
    mark('ready; enter: pair [native|browser] | start | ask | look [name] | quit');
    const input = createInterface({ input: process.stdin });
    for await (const line of input) {
        const [name, ...args] = line.trim().split(/\s+/);
        if (name === 'quit') break;
        if (!(name in commands)) { console.error('commands: pair [native|browser] | start | ask | look [name] | quit'); continue; }
        await commands[name](...args).catch((error) => mark(`${name} failed: ${error.message}`));
    }
} finally {
    await lab?.stop();
    stub.close();
    process.stdin.destroy();
}
