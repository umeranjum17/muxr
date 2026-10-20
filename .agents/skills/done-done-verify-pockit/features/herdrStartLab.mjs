// Agent and shell starts against a lab Herdr socket through the host's real
// session source: where a start lands (one labelled tab in the folder's
// workspace), the plan-account overlay reaching the agent process, and a failed
// start leaving nothing behind.
// Usage: node herdrStartLab.mjs <lab socket> <scratch dir>
// Starts a real `pi` (no sign-in needed); everything else is a shell.
import { mkdirSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { createHerdrSessionSource } from '../../../../apps/host/dist/agent/infrastructure/herdrSessionSource.js';

const [socketPath, dir] = process.argv.slice(2);
const source = await createHerdrSessionSource({ socketPath, dataDir: `${dir}/data`, artifactsDir: `${dir}/att`, hostHttpPort: 0 });
let failed = false;
const check = (ok, line) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${line}`); if (!ok) failed = true; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rpc = (method, params) => new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'start-lab', method, params })}\n`));
    socket.on('data', (chunk) => {
        buffer += String(chunk);
        const line = buffer.split('\n')[0];
        if (line === buffer) return;
        socket.destroy();
        const message = JSON.parse(line);
        message.error == null ? resolve(message.result) : reject(new Error(JSON.stringify(message.error)));
    });
});
const folder = (name) => { const path = join(dir, name); mkdirSync(path, { recursive: true }); return path; };
const workspaces = async () => { await source.refreshHerdr(); return (await source.herdrTree()).workspaces; };
const labelled = async (cwd) => (await rpc('workspace.list', {})).workspaces.filter((w) => w.label === cwd);
const tabsOf = async (cwd) => {
    const [workspace] = await labelled(cwd);
    return workspace === undefined ? [] : (await rpc('tab.list', { workspace_id: workspace.workspace_id })).tabs;
};
const paneOf = async (sessionId) => (await workspaces()).flatMap((w) => w.tabs.flatMap((t) => t.panes)).find((p) => p.sessionId === sessionId);
// The agent's own process environment, read where the kernel keeps it.
const agentEnv = async (paneId) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const info = (await rpc('pane.process_info', { pane_id: paneId })).process_info;
        const agent = info?.foreground_processes?.find((process) => process.pid !== info.shell_pid);
        if (agent !== undefined) {
            return Object.fromEntries(readFileSync(`/proc/${agent.pid}/environ`, 'utf8').split('\0').filter(Boolean)
                .map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
        }
        await sleep(250);
    }
    return undefined;
};
const say = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`);

try {
    // 1. An agent in a folder with no workspace yet: one workspace, one tab, named for the task.
    const repo = folder('repo');
    const first = await source.start({ cwd: repo, kind: 'pi', taskTitle: 'Umer lab task',
        planEnv: { MUXR_LAB_ACCOUNT: 'umer-lab' }, planUnset: ['MUXR_LAB_DROP'] });
    say('agent start', 'info' in first ? { id: first.info.id } : first);
    check('info' in first, 'pi starts in a new folder');
    const tabs = await tabsOf(repo);
    say('tabs after first start', tabs.map((tab) => tab.label));
    check(tabs.length === 1 && tabs[0].label === 'Umer lab task', 'the new workspace holds one tab, labelled with the task');

    // 2. The plan-account overlay reached the agent process itself.
    const pane = 'info' in first ? await paneOf(first.info.id) : undefined;
    const env = pane === undefined ? undefined : await agentEnv(pane.paneId);
    say('agent env', env === undefined ? null : { MUXR_LAB_ACCOUNT: env.MUXR_LAB_ACCOUNT ?? null, MUXR_LAB_DROP: env.MUXR_LAB_DROP ?? null });
    check(env?.MUXR_LAB_ACCOUNT === 'umer-lab' && env.MUXR_LAB_DROP === undefined, 'the account overlay holds in the agent process');

    // 3. A second agent in the same folder reuses the workspace with its own labelled tab.
    const second = await source.start({ cwd: repo, kind: 'pi', taskTitle: 'Umer second task' });
    const reused = await tabsOf(repo);
    say('tabs after second start', reused.map((tab) => tab.label));
    check('info' in second && (await labelled(repo)).length === 1 && reused.length === 2
        && reused.some((tab) => tab.label === 'Umer second task'), 'a second start reuses the workspace in a new labelled tab');

    // 4. A labelled shell in a new folder: one tab with that label.
    const notes = folder('notes');
    const shell = await source.start({ cwd: notes, kind: 'shell', label: 'Umer shell' });
    const shellTabs = await tabsOf(notes);
    say('shell tabs', shellTabs.map((tab) => tab.label));
    check('info' in shell && shellTabs.length === 1 && shellTabs[0].label === 'Umer shell', 'a labelled shell lands in one labelled tab');
    if ('info' in shell) await source.abort(shell.info.id);
    check(true, 'abort on a shell route returns');

    // 5. A start that cannot launch leaves no workspace behind.
    const missing = folder('missing');
    const refused = await source.start({ cwd: missing, kind: 'no-such-agent', taskTitle: 'Umer missing' });
    await sleep(500);
    const left = await labelled(missing);
    say('failed start', { result: refused, workspacesLeft: left.length });
    check(!('info' in refused) && left.length === 0, 'a failed start leaves no workspace behind');
} finally {
    await source.dispose();
}
console.log(failed ? 'FAIL herdrStartLab' : 'PASS herdrStartLab');
process.exit(failed ? 1 : 0);
