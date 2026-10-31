// Two computers for "Move to another computer": Desk and Laptop, each a real lab host
// (relay + host + guarded Herdr lab session) with a stand-in Claude signed in through the
// accounts kit. The stand-in keeps its conversation as a real Claude transcript
// (projects/<folder>/<id>.jsonl under its sign-in folder), and resumes a conversation by id
// wherever it finds it. Never a real account. See move-to-computer.md. Run from the repo root
// with HERDR_LAB_HELPER set:
//   node .agents/skills/done-done-verify-pockit/features/moveLab.mjs <labRoot>
// It writes <labRoot>/lab.json
// (ports, sessions, the agent on Desk) and runs until <labRoot>/stop exists. MUXR_RELAY_HOST names
// a non-loopback address both relays bind, so the app can probe the other computer from the one
// it is connected to (a loopback relay is only ever reached by switching to it).
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';

const [root] = process.argv.slice(2);
const helper = process.env.HERDR_LAB_HELPER;
if (!helper) throw new Error('HERDR_LAB_HELPER is required.');
const repo = process.cwd();
const { linkHerdrLab } = await import(join(repo, 'scripts/diagnostics/application/linkHerdrLab.mjs'));
const { requestLab } = await import(join(repo, 'scripts/diagnostics/application/linkLabClient.mjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

// A direct interpreter line, not `env node`: Herdr names an agent by its process, which a second exec would rename to node.
const standIn = (session) => `#!${process.execPath}
const fs = require('fs'), path = require('path'), cp = require('child_process'), readline = require('readline');
const dir = process.env.CLAUDE_CONFIG_DIR;
if (!dir) { console.log('lab stand-in needs an account folder'); process.exit(1); }
const args = process.argv.slice(2);
const accountFile = path.join(dir, 'lab-account.json');
if (args[0] === 'auth' && args[1] === 'status') {
  if (fs.existsSync(accountFile)) { process.stdout.write(fs.readFileSync(accountFile)); process.exit(0); }
  process.stdout.write('{"loggedIn":false,"authMethod":"none"}\\n'); process.exit(1);
}
if (args[0] === 'auth' && args[1] === 'login') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(accountFile, JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: process.env.LAB_ACCOUNT_EMAIL || 'lab@example.com', subscriptionType: 'max' }) + '\\n');
  console.log('Signed in'); process.exit(0);
}
const session = ${JSON.stringify(session)};
const herdr = (a) => cp.spawnSync(${JSON.stringify(helper)}, ['run', session, ...a], { stdio: 'ignore' });
const seq = () => String(BigInt(Date.now()) * 1000000n + (process.hrtime.bigint() % 1000000n));
const report = (state) => herdr(['pane', 'report-agent', '--source', 'herdr:claude', '--agent', 'claude', '--state', state, '--seq', seq(), process.env.HERDR_PANE_ID]);
const account = fs.existsSync(accountFile) ? JSON.parse(fs.readFileSync(accountFile)).email : 'no account';
const slug = process.cwd().replace(/[^A-Za-z0-9]/g, '-');
const projects = path.join(dir, 'projects');
// The accounts kit links an account's history to the computer's own store, which may not exist yet; a CLI writes through the link.
try { fs.mkdirSync(fs.readlinkSync(projects), { recursive: true }); } catch (error) { if (error.code !== 'EINVAL' && error.code !== 'ENOENT') throw error; }
let id = null, file = null;
const at = args.indexOf('--resume');
if (at >= 0) {
  id = args[at + 1];
  for (const p of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
    const f = path.join(projects, p, id + '.jsonl'); if (fs.existsSync(f)) file = f;
  }
  if (!file) { console.log('No conversation found with session ID: ' + id); process.exit(1); }
} else {
  id = require('crypto').randomUUID();
  fs.mkdirSync(path.join(projects, slug), { recursive: true });
  file = path.join(projects, slug, id + '.jsonl');
}
const append = (o) => fs.appendFileSync(file, JSON.stringify({ sessionId: id, cwd: process.cwd(), version: '2.1.0', timestamp: new Date().toISOString(), ...o }) + '\\n');
if (!fs.existsSync(file) || fs.statSync(file).size === 0) append({ type: 'system', content: 'lab conversation start' });
process.stdout.write('\\x1b[2J\\x1b[H');
console.log('Claude Code (lab stand-in) as ' + account + ' in ' + process.cwd());
if (at >= 0) {
  console.log('Resumed this conversation:');
  for (const l of fs.readFileSync(file, 'utf8').split('\\n').filter(Boolean)) {
    const o = JSON.parse(l);
    if (o.type === 'user') console.log('  you: ' + o.message.content);
    if (o.type === 'assistant') console.log('  claude: ' + o.message.content);
  }
}
setTimeout(() => { herdr(['pane', 'report-agent-session', '--source', 'herdr:claude', '--agent', 'claude', '--seq', seq(), '--agent-session-id', id, process.env.HERDR_PANE_ID]); report('idle'); }, 1500);
const rl = readline.createInterface({ input: process.stdin });
process.stdout.write('> ');
rl.on('line', (line) => {
  report('working');
  append({ type: 'user', message: { role: 'user', content: line } });
  const reply = 'I remember this conversation. You said: ' + line;
  append({ type: 'assistant', message: { role: 'assistant', content: reply } });
  console.log('  claude: ' + reply); process.stdout.write('> ');
  report('idle');
});
`;
const sdk = process.env.ANDROID_HOME ?? join(process.env.HOME ?? '', 'Android/Sdk');
// Each computer's stand-in names its own Herdr session, so its lifecycle reports reach that computer's Herdr.
const pathFor = (name, session) => {
    const bin = join(root, name.toLowerCase(), 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'claude'), standIn(session), { mode: 0o755 });
    chmodSync(join(bin, 'claude'), 0o755);
    return [bin, dirname(process.execPath), join(sdk, 'platform-tools'), '/usr/bin', '/bin'].join(':');
};

// An offer lives only while its socket stays open, so each computer keeps its latest one until the next mint.
const offers = new Map();
const mint = (path) => new Promise((resolve, reject) => {
    offers.get(path)?.destroy();
    const socket = createConnection(path);
    offers.set(path, socket);
    let pending = '';
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`${JSON.stringify({ intent: { kind: 'browser', authority: 'control', personal: false } })}\n`));
    socket.on('data', (chunk) => {
        pending += String(chunk);
        for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
            const event = JSON.parse(pending.slice(0, end));
            pending = pending.slice(end + 1);
            if (event.offer) resolve(event.offer.text);
            if (event.approval) socket.write('{"yes":true}\n');
            if (event.error) reject(new Error(event.error));
        }
    });
});

const labs = [];
const up = async (name) => {
    const dir = join(root, name.toLowerCase());
    const work = join(dir, 'work');
    mkdirSync(work, { recursive: true });
    process.env.MUXR_LAB_MACHINE_NAME = name;
    // The caller names each computer's Herdr session up front, so its own exit trap can tear both down.
    process.env.HERDR_LAB_SESSION = process.env[`${name.toUpperCase()}_SESSION`];
    process.env.PATH = pathFor(name, process.env.HERDR_LAB_SESSION);
    process.env.LAB_ACCOUNT_EMAIL = `${name.toLowerCase()}@example.com`;
    const lab = await linkHerdrLab(dir, name.slice(0, 2).toLowerCase(), undefined, (run) => run(['workspace', 'create', '--cwd', work, '--label', 'work', '--no-focus']));
    labs.push(lab);
    // The accounts kit adds the computer's own sign-in and runs the stand-in's login command.
    const { planAccounts } = await import(join(repo, 'apps/host/dist/plans/planAccounts.js'));
    const added = await planAccounts(lab.env).add('claude');
    execFileSync('/bin/sh', ['-c', added.signIn.shell], { stdio: 'ignore', env: lab.env, timeout: 30_000 });
    log(`${name} up: relay ${lab.port}, herdr ${lab.session}; PIDs ${lab.pids().join(',')}`);
    return { lab, dir, work, accountId: added.account.id };
};
let desk, laptop;
try {
    desk = await up('Desk');
    laptop = await up('Laptop');
    const started = await requestLab(desk.lab.link, 'session.start', { cwd: desk.work, kind: 'claude', planAccount: desk.accountId, label: 'release-notes' });
    // An agent's route changes once it settles, so find it again by kind each time.
    const claude = async () => (await requestLab(desk.lab.link, 'session.list', {})).find((row) => row.agentKind === 'claude');
    let sessionId = started.info.id;
    for (let i = 0; i < 60; i += 1) {
        await sleep(1000);
        const row = await claude();
        if (i % 10 === 0) log(`poll ${i}: ${JSON.stringify((await requestLab(desk.lab.link, 'session.list', {})).map((r) => ({ id: r.id, kind: r.agentKind, st: r.agentStatus })))}`);
        if (i === 12 && row !== undefined) {
            try { const pane = (await requestLab(desk.lab.link, 'session.open', { sessionId: row.id })).info.paneId; log(`pane ${pane}:\n${desk.lab.herdr(['pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', '25'])}`); } catch (error) { log(`pane read: ${error.message}`); }
        }
        if (row === undefined) continue;
        sessionId = row.id;
        const s = await requestLab(desk.lab.link, 'session.status', { sessionId }).catch((error) => { if (i % 10 === 0) log(`status: ${error.message}`); });
        if (s?.agentStatus === 'idle') { await sleep(8000); sessionId = (await claude())?.id ?? sessionId; break; }
    }
    for (let attempt = 1; ; attempt += 1) {
        try { await requestLab(desk.lab.link, 'session.prompt', { sessionId, text: 'The launch word is saffron. Remember it.' }); break; }
        catch (error) {
            if (attempt === 8) throw error;
            log(`prompt retry ${attempt}: ${error.message}`);
            await sleep(2000);
            sessionId = (await claude())?.id ?? sessionId;
        }
    }
    sessionId = (await claude()).id;
    await sleep(3000);
    writeFileSync(join(root, 'lab.json'), JSON.stringify({ sessionId, desk: { port: desk.lab.port, session: desk.lab.session, work: desk.work }, laptop: { port: laptop.lab.port, session: laptop.lab.session, work: laptop.work } }));
    log('ready; links written; running until the stop file appears');
    // A pairing offer lasts about two minutes, so the driver asks for one when it is ready to use it:
    // touch <labRoot>/mint-desk (or mint-laptop) and read <labRoot>/desk-link.txt (or laptop-link.txt) once the request file is gone.
    while (!existsSync(join(root, 'stop'))) {
        for (const [one, name] of [[desk, 'desk'], [laptop, 'laptop']]) {
            if (!existsSync(join(root, `mint-${name}`))) continue;
            writeFileSync(join(root, `${name}-link.txt`), await mint(join(one.dir, 'host', 'pair.sock')));
            rmSync(join(root, `mint-${name}`));
        }
        await sleep(500);
    }
} finally {
    for (const socket of offers.values()) socket.destroy();
    for (const lab of labs.reverse()) await lab.stop().catch((error) => log(`stop failed: ${error.message}`));
    log('done');
}
