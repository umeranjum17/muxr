// Times a composer send from the link to the agent's pane: host confirm and on-screen echo.
// See send-feedback.md. Run from the repo root after `yarn build`, inside a Herdr lab.
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { startSendLab } from './.agents/skills/done-done-verify-pockit/features/sendLab.mjs';

const { EVIDENCE } = process.env;
if (!EVIDENCE) throw new Error('Set EVIDENCE to the run evidence directory');
const SENDS = Number(process.env.SENDS ?? 20);
const BUSY = Number(process.env.BUSY ?? 3);
const FLEET = Number(process.env.FLEET ?? 40);
const PHASES = (process.env.PHASES ?? 'idle,working,busy,fleet').split(',').filter(Boolean);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mark = (line) => {
    const stamped = `${new Date().toISOString()} lab: ${line}`;
    console.log(stamped);
    appendFileSync(join(EVIDENCE, 'lab-timeline.log'), `${stamped}\n`);
};
const pct = (values, p) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)];
};
// The stream's ANSI and control bytes dropped, so a prompt's words read as typed.
const plain = (text) => text.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_]|[\x00-\x08\x0b-\x1f]/g, '');

let stage;
try {
    stage = await startSendLab(mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'send-')), { agents: 1 + BUSY });
    const { lab, request, settle, workdir } = stage;
    const [target, ...others] = stage.agents;
    mark(`herdr session ${lab.session}; target + ${others.length} others idle`);

    // The phone's own view of the pane: a terminal stream on the link, as the agent screen opens it.
    const stream = await lab.link.stream('terminal', { requestId: `send-${Date.now()}`, sessionId: target.id,
        channel: `tm_send_${Date.now().toString(36)}`, cols: 60, rows: 30, takeover: true });
    let screen = '';
    let rest = '';
    stream.onData = (chunk) => {
        const all = (rest + Buffer.from(chunk).toString('utf8')).split('\n');
        rest = all.pop();
        for (const line of all) {
            if (!line.includes('"terminal.frame"')) continue;
            const bytes = JSON.parse(line).bytes;
            screen = (screen + plain(Buffer.from(bytes, 'base64').toString('utf8'))).slice(-20_000);
        }
    };
    const samples = [];
    const send = async (phase, n) => {
        const token = `zq${n}${Math.random().toString(36).slice(2, 6)}`;
        const before = screen.length;
        const t0 = performance.now();
        let confirm;
        let echo;
        let error;
        const answered = request('session.prompt', { sessionId: target.id, text: `Reply ok ${token}`, streamingBehavior: 'steer' })
            .then(() => { confirm = performance.now() - t0; }, (cause) => { error = cause.message; });
        const deadline = t0 + 20_000;
        while (performance.now() < deadline && (echo === undefined || confirm === undefined) && error === undefined) {
            if (echo === undefined && screen.slice(Math.max(0, before - 200)).includes(token)) echo = performance.now() - t0;
            await sleep(5);
        }
        await answered;
        const sample = { phase, n, confirmMs: confirm === undefined ? null : Math.round(confirm), echoMs: echo === undefined ? null : Math.round(echo), ...(error ? { error } : {}) };
        samples.push(sample);
        mark(`${phase} #${n} confirm ${sample.confirmMs} ms echo ${sample.echoMs} ms${error ? ` error ${error}` : ''}`);
    };
    const longTurn = 'Without using any tools, print the lines MARK-1 to MARK-4000, one per line, each followed by a short sentence about the sea.';
    for (const phase of PHASES) {
        if (phase === 'working') {
            await request('session.prompt', { sessionId: target.id, text: longTurn, streamingBehavior: 'steer' });
            await settle(target, ['working']);
        }
        if (phase === 'busy') {
            for (const info of others) await request('session.prompt', { sessionId: info.id, text: longTurn, streamingBehavior: 'steer' });
            await sleep(2000);
        }
        // A big fleet: workspaces whose shells retitle themselves the way working agents' spinners do.
        if (phase === 'fleet') {
            for (let i = 1; i <= FLEET; i++) {
                const created = lab.herdr(['workspace', 'create', '--cwd', workdir, '--label', `fleet-${i}`, '--no-focus']);
                const paneId = /"pane_id"\s*:\s*"([^"]+)"/.exec(created)?.[1];
                if (paneId === undefined) throw new Error(`no pane in workspace create answer: ${created.slice(0, 200)}`);
                lab.herdr(['pane', 'run', paneId, `while :; do printf '\\033]0;Umer fleet ${i} %s\\007' $RANDOM; sleep 0.3; done`]);
            }
            mark(`fleet of ${FLEET} retitling workspaces up`);
            await sleep(3000);
        }
        for (let n = 1; n <= SENDS; n++) {
            if (phase === 'idle') await settle(target, ['idle', 'done']).catch(() => undefined);
            await sleep(400 + Math.random() * 800);
            await send(phase, n);
        }
        if (phase === 'working') await request('session.abort', { sessionId: target.id }).catch(() => undefined);
    }
    stream.end();
    const summary = {};
    for (const phase of PHASES) {
        const rows = samples.filter((s) => s.phase === phase);
        const of = (key) => rows.map((s) => s[key]).filter((v) => v !== null);
        summary[phase] = { sends: rows.length, failed: rows.filter((s) => s.error || s.echoMs === null).length,
            confirm: { p50: pct(of('confirmMs'), 50), p95: pct(of('confirmMs'), 95), max: Math.max(...of('confirmMs')) },
            echo: { p50: pct(of('echoMs'), 50), p95: pct(of('echoMs'), 95), max: Math.max(...of('echoMs')) } };
    }
    writeFileSync(join(EVIDENCE, 'send-latency.json'), `${JSON.stringify({ samples, summary }, null, 2)}\n`);
    writeFileSync(join(EVIDENCE, 'host.log'), lab.hostOutput());
    for (const [phase, s] of Object.entries(summary)) {
        mark(`summary ${phase}: confirm p50 ${s.confirm.p50} p95 ${s.confirm.p95} max ${s.confirm.max}; echo p50 ${s.echo.p50} p95 ${s.echo.p95} max ${s.echo.max}; failed ${s.failed}/${s.sends}`);
    }
} finally {
    await stage?.stop();
}
