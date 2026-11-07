// The proof harness on a lab Herdr Core (plan step 2), no phone: fakeStack starts this checkout's
// built relay and host over the fake Herdr TUI, with a private lab Herdr Core beside them. The
// journey then drives every call the host will make on the core once it reads Herdr Core (plan
// step 3): one event subscription, a labelled agent start, prompt and wait for done, a label
// change, a framed live view that types, the screen read back, versioned documents, and kill and
// remove. The host is not pointed at the core: it cannot see Core agents yet, and this journey
// claims nothing about it beyond coming up beside the core. Writes gate.log, one text capture
// per call group and steps.json. See herdr-core-lab.md.
//   node .agents/skills/done-done-verify-pockit/features/herdrCoreLab.mjs <evidenceDir>
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [evidence] = process.argv.slice(2);
if (!evidence) throw new Error('usage: herdrCoreLab.mjs <evidenceDir>');
const repo = process.cwd();
const { startFakeStack } = await import(join(repo, 'perf/lib/fakeStack.mjs'));
const { ensureHerdrCore, HERDR_CORE_PIN } = await import(join(repo, 'perf/lib/herdrCoreLab.mjs'));
mkdirSync(evidence, { recursive: true });
const gate = join(evidence, 'gate.log');
const log = (line) => { console.log(line); appendFileSync(gate, `${line}\n`); };
const capture = (name, lines) => writeFileSync(join(evidence, name), `${lines.join('\n')}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plain = (text) => text.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[0-9;?=!]*[A-Za-z]|\x1b[A-Za-z=>]|[\x00-\x08\x0b-\x1f]/g, '');
const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok }); log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`); };

let stack;
let api;
let events;
try {
    // 1. The pinned core, its digest held to the pin and the release manifest.
    const pin = await ensureHerdrCore();
    capture('01-pin.txt', [
        `herdr-core ${pin.version} (${pin.target}), protocol generation ${HERDR_CORE_PIN.generation}`,
        `sha256 pinned   ${pin.sha256.pinned}`,
        `sha256 file     ${pin.sha256.file}`,
        `sha256 manifest ${pin.sha256.manifest}`,
    ]);
    check('pinned release', pin.sha256.file === pin.sha256.pinned && pin.sha256.manifest === pin.sha256.pinned,
        `hc ${pin.version}, file and release manifest both ${pin.sha256.pinned.slice(0, 12)}…`);

    // 2. fakeStack with the core beside the fake Herdr TUI; the host comes up as before.
    stack = await startFakeStack({ transport: 'loopback', herdrCore: true });
    const core = stack.herdrCore;
    for (let i = 0; i < 300 && !stack.hostLog().includes('link relay: online'); i += 1) await sleep(200);
    const status = core.hc(['server', 'status']);
    capture('02-stack.txt', [
        `host build ${head}; relay on 127.0.0.1:${stack.relayPort} (kernel-picked), host pid ${stack.pids.host}, fake Herdr TUI pid ${stack.herdrPid}`,
        `lab Herdr Core pid ${core.pid}, HC_SESSION=${core.session}, dir ${core.dir} (mode 700), socket ${core.socket} (${core.socket.length} bytes)`,
        `hc server status: ${JSON.stringify({ pid: status.pid, version: status.version, live: status.live, holders: status.holders })}`,
        `host online: ${stack.hostLog().includes('link relay: online')}`,
        `host env points at the core: no (the host reads Herdr TUI only until plan step 3)`,
    ]);
    check('stack beside the core', stack.hostLog().includes('link relay: online') && status.pid === core.pid && core.session.length === 2 && core.dir.length <= 8,
        `host online on relay ${stack.relayPort}; core pid ${core.pid} answers on its own ${core.session} session`);

    // 3. One subscription for the whole list, before anything starts (snapshot, then events).
    events = await core.connect();
    const snapshot = await events.call('events.subscribe', {});
    api = await core.connect();

    // A stand-in agent that reports status the way Claude and Codex do (OSC 7501).
    const agent = join(core.env.HOME, 'fake-agent.sh');
    writeFileSync(agent, [
        '#!/bin/sh',
        "s(){ printf '\\033]7501;state=%s:app=fake-agent\\033\\\\' \"$1\"; }",
        's idle; echo "fake agent ready as $HC_TERMINAL_ID"',
        'while IFS= read -r line; do s working; echo "thinking about: $line"; sleep 1; echo "answer: done with \'$line\'"; s done; done',
        '',
    ].join('\n'));
    chmodSync(agent, 0o755);

    // 4. Start it the way the host will: argv, cwd, name, the Herdr app's space and tab labels, keep.
    const labels = { 'herdr.space': 'pockit', 'herdr.tab': 'fix-login', 'muxr.kind': 'fake-agent', 'muxr.resume': 'fake-agent.sh' };
    const run = await api.call('terminal.run', { argv: [agent], cwd: core.env.HOME, name: 'lab-agent', labels, keep: true });
    const address = run.address;
    await sleep(800);
    // 5. Prompt and wait for done.
    const sent = await api.call('terminal.send', { terminal: address, text: 'fix the login bug' });
    const waited = await api.call('terminal.wait', { terminal: address, timeout: 20_000 }, 30_000);
    // 6. Move it to another tab: a label change.
    await api.call('terminal.label', { terminal: address, labels: { 'herdr.tab': 'review' } });
    const record = await api.call('terminal.get', { terminal: address });
    capture('03-start-prompt.txt', [
        `subscribe snapshot: seq ${snapshot.seq}, ${snapshot.terminals.length} terminals`,
        `terminal.run -> ${JSON.stringify({ address, name: run.name, state: run.state, labels: run.labels, keep: run.keep })}`,
        `terminal.send "fix the login bug" -> ${JSON.stringify(sent)}`,
        `terminal.wait -> ${JSON.stringify({ status: waited.status, turn: waited.turn, reason: waited.reason })}`,
        `terminal.label herdr.tab=review -> labels now ${JSON.stringify(record.labels)}`,
    ]);
    check('start, prompt, done', waited.status === 'done' && waited.turn === 1 && run.labels['herdr.space'] === 'pockit',
        `${address} in space pockit, prompted, wait says ${waited.status} after turn ${waited.turn}`);
    check('labels move a tab', record.labels['herdr.tab'] === 'review' && record.labels['herdr.space'] === 'pockit', `herdr.tab fix-login -> ${record.labels['herdr.tab']}`);

    // 7. The live view: framed mode, attach at a phone-sized grid, type, see the answer.
    const hello = await api.hello();
    const attach = await api.call('terminal.attach', { terminal: address, cols: 48, rows: 20 });
    await sleep(400);
    api.type(attach.channel, 'echo hi\r');
    let live = '';
    for (let i = 0; i < 50 && !live.includes("answer: done with 'echo hi'"); i += 1) { await sleep(100); live = plain(api.screen(attach.channel)); }
    api.detach(attach.channel);
    const read = await api.call('terminal.read', { terminal: address });
    const screen = plain(typeof read === 'string' ? read : JSON.stringify(read));
    capture('04-live-view.txt', [
        `hello -> generation ${hello.generation}, version ${hello.version}, features ${hello.features.join(',')}`,
        `terminal.attach 48x20 -> channel ${attach.channel}, size ${attach.terminal.cols}x${attach.terminal.rows}`,
        'typed: echo hi',
        '--- live view (escape codes stripped) ---',
        live.trim(),
        '--- terminal.read ---',
        screen.trim().slice(-1200),
    ]);
    check('live view types', live.includes("answer: done with 'echo hi'") && attach.terminal.cols === 48, 'typed "echo hi" over the attach stream and saw the answer at 48 columns');
    check('HC_TERMINAL_ID identity', screen.includes(`fake agent ready as ${address}`), `the agent saw HC_TERMINAL_ID=${address}`);
    check('generation pinned', hello.generation === HERDR_CORE_PIN.generation, `hello says generation ${hello.generation}`);

    // 8. Documents: the Herdr app's layout name reads empty on a fresh core; writes are versioned.
    const app = await api.call('doc.get', { name: 'herdr-app' });
    const set1 = await api.call('doc.set', { name: 'muxr-lab', value: { spaces: [{ name: 'pockit', tabs: ['fix-login', 'review'] }] }, version: 0 });
    const stale = await api.call('doc.set', { name: 'muxr-lab', value: { spaces: [] }, version: 0 }).then((r) => ({ wrote: r }), (e) => ({ kind: e.kind, message: e.message }));
    const back = await api.call('doc.get', { name: 'muxr-lab' });
    capture('05-documents.txt', [
        `doc.get herdr-app -> ${JSON.stringify(app)}`,
        `doc.set muxr-lab version 0 -> ${JSON.stringify(set1)}`,
        `doc.set muxr-lab version 0 again (stale) -> ${JSON.stringify(stale)}`,
        `doc.get muxr-lab -> ${JSON.stringify(back)}`,
    ]);
    check('versioned documents', app.version === 0 && stale.kind === 'conflict' && back.version === 1 && back.value.spaces[0].name === 'pockit',
        `fresh herdr-app reads version 0; a stale write is refused (${stale.kind}); muxr-lab reads back at version ${back.version}`);

    // 9. Stop it and remove it.
    await api.call('terminal.kill', { terminal: address });
    for (let i = 0; i < 50; i += 1) {
        const state = await api.call('terminal.get', { terminal: address }).then((t) => t.state, () => 'gone');
        if (state === 'finished') break;
        await sleep(100);
    }
    await api.call('terminal.rm', { terminal: address });
    await sleep(300);
    const kinds = events.events.filter((e) => e.method === 'event').map((e) => e.params.type);
    const seen = [...new Set(kinds)];
    capture('06-events.txt', [
        `events on the one subscription, in order (${kinds.length}):`,
        kinds.join(' '),
        `distinct: ${seen.join(', ')}`,
    ]);
    const wanted = ['created', 'status', 'turn', 'labels', 'doc', 'finished', 'removed'];
    check('one event stream', wanted.every((k) => seen.includes(k)), `saw ${wanted.filter((k) => seen.includes(k)).join(', ')}${wanted.some((k) => !seen.includes(k)) ? `; missing ${wanted.filter((k) => !seen.includes(k)).join(', ')}` : ''}`);

    // 10. Teardown: the core goes by its scoped stop, its folder with it, then the stack.
    events.close(); api.close(); events = undefined; api = undefined;
    const { stoppedBy } = await core.stop();
    const alive = spawnSync('ps', ['-p', String(core.pid)], { stdio: 'ignore' }).status === 0;
    capture('07-teardown.txt', [
        `core stopped by: ${stoppedBy}`,
        `ps -p ${core.pid}: ${alive ? 'still running' : 'gone'}`,
        `${core.dir}: ${existsSync(core.dir) ? 'still there' : 'removed'}`,
    ]);
    check('clean teardown', !alive && !existsSync(core.dir), `${stoppedBy}; pid ${core.pid} gone; ${core.dir} removed`);
} catch (cause) {
    check('journey ran', false, cause instanceof Error ? cause.stack ?? cause.message : String(cause));
} finally {
    events?.close();
    api?.close();
    await stack?.herdrCore?.stop();
    stack?.stop();
    // Everything this run started is gone before it reports: relay and host by their own PIDs.
    const ours = stack ? [stack.pids.relay, stack.pids.host] : [];
    const running = () => ours.filter((pid) => spawnSync('ps', ['-p', String(pid)], { stdio: 'ignore' }).status === 0);
    for (let i = 0; i < 100 && running().length > 0; i += 1) await sleep(100);
    if (stack) check('stack stopped', running().length === 0 && !existsSync(stack.root), `relay ${stack.pids.relay} and host ${stack.pids.host} gone; ${stack.root} removed`);
}

const ok = checks.length > 0 && checks.every((c) => c.ok);
writeFileSync(join(evidence, 'steps.json'), `${JSON.stringify({
    target: { version: `this checkout's harness at ${head}, with the muxr relay and host built from it, on a private lab Herdr Core ${HERDR_CORE_PIN.version}` },
    start: 'fakeStack with the fake Herdr TUI and a private lab Herdr Core beside it (2-character HC_SESSION, private XDG dirs, our own foreground child)',
    steps: [
        'Check the pinned Herdr Core against the pin and the release manifest',
        'Start fakeStack with herdrCore and wait for the host to come online',
        'Subscribe to events, then start a labelled stand-in agent in space pockit',
        'Prompt it and wait for done; move it to another tab by label',
        'Attach in framed mode at 48 columns, type echo hi, read the screen back',
        'Read the herdr-app document, write a versioned document, refuse a stale write',
        'Kill and remove the agent; stop the core and the stack',
    ],
    result: `the harness drives a lab Herdr Core through the calls the host will make (the host itself cannot see Core agents until plan step 3): gate.log lists ${checks.filter((c) => c.ok).length} of ${checks.length} checks passing; ${ok ? 'pass' : 'fail'}`,
}, null, 2)}\n`);
log(ok ? 'PASS: the harness ran the host-side Herdr Core calls on a private lab core and tore it down' : 'FAIL: see above');
process.exit(ok ? 0 : 1);
