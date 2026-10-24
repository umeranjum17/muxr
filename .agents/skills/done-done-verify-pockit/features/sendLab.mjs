// The send-feedback labs' shared stage: a lab host on a provisioned Herdr lab with Claude
// Code on the canned fixture (labStub.mjs) in the lab's own HOME. See send-feedback.md.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

const repo = process.cwd();
const { linkHerdrLab } = await import(join(repo, 'scripts/diagnostics/application/linkHerdrLab.mjs'));
const { requestLab } = await import(join(repo, 'scripts/diagnostics/application/linkLabClient.mjs'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startSendLab(root, { lps = '6', agents = 1 } = {}) {
    const stub = spawn(process.execPath, [join(repo, '.agents/skills/done-done-verify-pockit/features/labStub.mjs')],
        { env: { ...process.env, STUB_LPS: lps }, stdio: ['ignore', 'pipe', 'inherit'] });
    const stubUrl = await new Promise((resolve) => stub.stdout.on('data', (chunk) => {
        const port = /listening on (\d+)/.exec(String(chunk))?.[1];
        if (port) resolve(`http://127.0.0.1:${port}`);
    }));
    const workdir = join(root, 'work');
    mkdirSync(workdir, { recursive: true });
    mkdirSync(join(root, 'lab'), { recursive: true });
    let lab;
    try {
        lab = await linkHerdrLab(join(root, 'lab'), 'send', undefined, (_herdr, session) => {
            const home = join(readFileSync(join(process.env.FM_HERDR_LAB_STATE_DIR, `${session}.xdg-root`), 'utf8').trim(), 'home');
            const write = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
            write(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'haiku', apiKeyHelper: 'echo lab-fixture-key',
                env: { ANTHROPIC_BASE_URL: stubUrl, DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } }));
            write(join(home, '.claude', '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark',
                projects: { [workdir]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }));
        });
    } catch (error) {
        stub.kill();
        throw error;
    }
    const request = (type, params) => requestLab(lab.link, type, params);
    const lifecycle = async (info) => (await request('session.status', { sessionId: info.id }))?.agentStatus;
    const settle = async (info, want, ms = 60_000) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            if (want.includes(await lifecycle(info).catch(() => undefined))) return;
            await sleep(250);
        }
        throw new Error(`${info.id} never reached ${want.join('/')}`);
    };
    const started = [];
    for (let i = 0; i < agents; i++) {
        started.push((await request('session.start', { cwd: workdir, kind: 'claude', label: i === 0 ? 'Umer send check' : `Umer busy ${i}` })).info);
    }
    for (const info of started) await settle(info, ['idle', 'done']);
    // One pairing offer for a device this lab does not drive itself; the host's approval is answered yes.
    let offering;
    const offer = (kind) => new Promise((resolve, reject) => {
        offering?.destroy();
        const socket = offering = createConnection(join(root, 'lab', 'host', 'pair.sock'));
        let pending = '';
        socket.on('error', reject);
        socket.on('connect', () => socket.write(`${JSON.stringify({ intent: { kind, authority: 'control', personal: false } })}\n`));
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
    // Herdr's own lifecycle report: an agent it calls unknown is not promptable, so the host holds then refuses.
    const setReady = (info, ready) => {
        lab.herdr(['pane', 'report-agent', info.paneId, '--source', 'umer-lab', '--agent', 'claude', '--state', ready ? 'idle' : 'unknown']);
        if (ready) lab.herdr(['pane', 'release-agent', info.paneId, '--source', 'umer-lab', '--agent', 'claude']);
    };
    return { lab, workdir, agents: started, request, settle, offer, setReady,
        stop: async () => { offering?.destroy(); await lab.stop(); stub.kill(); } };
}
