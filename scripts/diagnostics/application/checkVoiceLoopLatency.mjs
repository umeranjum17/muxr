/**
 * Realtime voice loop latency.
 *
 * Times the muxr hops of the loop a user feels when talking to an agent:
 * request -> agent pane, then agent reply -> spoken report. Real relay, real
 * host, real voice child, coordinator and Herdr lab session with one scripted
 * agent pane. The lab device replays the phone's frames and its report RPCs
 * (pane.read 20 lines -> voice.report -> realtime.say).
 *
 * The realtime provider is not involved: its data-channel events are sent by
 * the lab device, so provider VAD, model and speech time are excluded. The
 * delegation is structured JSON (no planner) unless VOICE_LOOP_CODEX_HOME
 * points at a lab-only Codex sign-in, which runs the real planner.
 * Logs only timings, never transcripts or credentials.
 *
 * Required: HERDR_LAB_HELPER (the guarded Herdr lab helper). Build first.
 * Run: node scripts/diagnostics/application/checkVoiceLoopLatency.mjs [reps]
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { linkHerdrLab } from './linkHerdrLab.mjs';
import { requestLab } from './linkLabClient.mjs';

if (!process.env.HERDR_LAB_HELPER) {
    process.stderr.write('SKIP: HERDR_LAB_HELPER is unset; set it to the guarded herdr lab helper.\n');
    process.exit(0);
}
const reps = Number(process.argv[2] ?? 10);
const natural = Boolean(process.env.VOICE_LOOP_CODEX_HOME);
const root = mkdtempSync(join(tmpdir(), 'voice-loop-'));
process.env.CODEX_HOME = process.env.VOICE_LOOP_CODEX_HOME ?? join(root, 'no-codex-login');
const agentScript = join(process.cwd(), 'scripts', 'diagnostics', 'fixtures', 'scripted-agent', 'pi');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const events = [];
const lab = await linkHerdrLab(root, 'voice-loop', (event) => events.push({ at: performance.now(), event }), (herdr) => {
    // The pane's agent reports through the same helper, so it needs the helper's state dir.
    const stateDir = process.env.FM_HERDR_LAB_STATE_DIR ? ['--env', `FM_HERDR_LAB_STATE_DIR=${process.env.FM_HERDR_LAB_STATE_DIR}`] : [];
    herdr(['workspace', 'create', '--label', 'lab', ...stateDir, '--no-focus']);
    const pane = JSON.parse(herdr(['pane', 'list'])).result.panes[0].pane_id;
    herdr(['pane', 'rename', pane, 'Fix the login bug']);
    herdr(['pane', 'run', pane, `${agentScript} ${join(root, 'herdr-lab.sh')} 2`]);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    herdr(['agent', 'rename', JSON.parse(herdr(['agent', 'list'])).result.agents[0].name, 'golf']);
});

const samples = {};
const add = (name, ms) => (samples[name] ??= []).push(ms);
let failure;
try {
    const stream = await lab.link.stream('voice', { channel: `rs_loop${process.pid}`.padEnd(12, '0') });
    const frames = [];
    const decoder = new TextDecoder();
    let partial = '';
    stream.onData = (chunk) => {
        partial += decoder.decode(chunk, { stream: true });
        const lines = partial.split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) { try { frames.push({ at: performance.now(), frame: JSON.parse(line) }); } catch { /* partial */ } }
    };
    const until = async (find, what) => {
        const deadline = performance.now() + 120_000;
        for (;;) {
            const hit = find();
            if (hit) return hit;
            if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
            await sleep(2);
        }
    };
    const frameAfter = (since, test, what) => until(() => frames.find((entry) => entry.at >= since && test(entry.frame)), what);
    const send = (frame) => stream.write(`${JSON.stringify(frame)}\n`);
    const providerEvent = (data) => send({ type: 'realtime.webrtc.data', data: JSON.stringify(data) });
    await frameAfter(0, (frame) => frame.type === 'realtime.webrtc.start', 'realtime.webrtc.start');
    await providerEvent({ type: 'session.started' });

    for (let rep = 0; rep < reps; rep++) {
        const id = `item_loop_${rep}_${process.pid}`;
        const text = `Please run the lab task number ${rep}`;
        const sent = performance.now();
        await providerEvent({ type: 'delegation.created', item: { type: 'delegation', target: 'client', id, user_bidi_turn_id: `turn_${rep}`,
            content: [{ type: 'input_text', text: natural ? `Ask golf to ${text.toLowerCase()}.` : JSON.stringify({ name: 'prompt_agent', arguments: { agent: 'golf', text } }) }] } });
        const ack = await frameAfter(sent, (frame) => frame.type === 'realtime.webrtc.data' && frame.data.includes(id), 'delegation result');
        add('request: delegation.created -> result back at phone', ack.at - sent);

        const lifecycle = (since, state) => events.find((entry) => entry.at >= since && entry.event?.event?.type === 'lifecycle.update'
            && entry.event.event.event?.state === state);
        const working = await until(() => lifecycle(sent, 'working'), 'working lifecycle push');
        const idle = await until(() => lifecycle(working.at, 'idle'), 'idle lifecycle push');
        let started = performance.now();
        const tail = await requestLab(lab.link, 'pane.read', { sessionId: idle.event.sessionId, lines: 20, source: 'recent_unwrapped', ansi: false });
        add('reply: pane.read 20 lines', performance.now() - started);
        const replied = Number(String(tail.text).match(/REPLY-(\d{13})/g)?.at(-1)?.slice(6));
        if (Number.isFinite(replied)) add('reply: agent printed reply -> lifecycle push at phone', performance.timeOrigin + idle.at - replied);
        started = performance.now();
        const report = await requestLab(lab.link, 'voice.report', { displayName: 'golf', taskTitle: 'Fix the login bug', status: 'idle', outcome: 'idle' });
        add('reply: voice.report', performance.now() - started);
        started = performance.now();
        await send({ type: 'realtime.say', text: report.say });
        await frameAfter(started, (frame) => frame.type === 'realtime.webrtc.data' && frame.data.includes('session.context.append'), 'context append');
        add('reply: realtime.say -> context append back at phone', performance.now() - started);
        await providerEvent({ type: 'turn.done', turn: { role: 'assistant', transcript: 'reported' } });
        await sleep(300);
    }
    stream.end();
} catch (error) {
    failure = error;
} finally {
    await lab.stop().catch((error) => process.stderr.write(`teardown: ${error.message}\n`));
    try {
        const journal = JSON.parse(readFileSync(join(root, 'host', 'diagnostics.json'), 'utf8'));
        for (const event of journal.events ?? []) {
            if (event.event === 'realtime.coordination') add(`host: coordinator ${event.operation}`, event.durationMs);
        }
    } catch { /* no journal */ }
    rmSync(root, { recursive: true, force: true });
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
console.log(`voice loop latency (${natural ? 'real Codex planner' : 'structured request, no planner'}), ms`);
for (const [name, values] of Object.entries(samples)) {
    const sorted = values.sort((a, b) => a - b);
    console.log(`  ${name}: n=${sorted.length} median=${Math.round(percentile(sorted, 0.5))} p90=${Math.round(percentile(sorted, 0.9))}`);
}
if (failure) {
    process.stderr.write(`FAIL: ${failure.message}\n`);
    process.exit(1);
}
