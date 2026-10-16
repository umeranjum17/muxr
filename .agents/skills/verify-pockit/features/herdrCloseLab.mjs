// The agent-close ladder against a lab Herdr socket: pane, tab, workspace and
// worktree-group-root closes through the host's real session source.
// Usage: node herdrCloseLab.mjs <lab socket> <scratch dir>
// Shell sessions only, so no agent CLI or login is needed.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHerdrSessionSource } from '../../../../apps/host/dist/agent/infrastructure/herdrSessionSource.js';

const [socketPath, dir] = process.argv.slice(2);
const source = await createHerdrSessionSource({ socketPath, dataDir: `${dir}/data`, artifactsDir: `${dir}/att`, hostHttpPort: 0 });
let failed = false;
const check = (ok, line) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${line}`); if (!ok) failed = true; };
const shell = async (cwd, extra = {}) => {
    mkdirSync(cwd, { recursive: true });
    const started = await source.start({ cwd, kind: 'shell', ...extra });
    if (!('info' in started)) throw new Error(`shell start failed: ${JSON.stringify(started)}`);
    return started.info;
};
const tree = async () => { await source.refreshHerdr(); return (await source.herdrTree()).workspaces; };
const workspaceOf = async (info) => (await tree()).find((w) => w.tabs.some((t) => t.panes.some((p) => p.sessionId === info.id)));
const paneIds = async () => (await tree()).flatMap((w) => w.tabs.flatMap((t) => t.panes.map((p) => p.paneId)));
// Close any other tab in the shell's workspace so the shell is the last tab.
const closeOtherTabs = async (info) => {
    const w = await workspaceOf(info);
    for (const tab of w.tabs) if (!tab.panes.some((p) => p.sessionId === info.id)) await source.closeTab(info.id, tab.tabId);
};
const say = (label, result) => console.log(`${label}: ${JSON.stringify(result)}`);

try {
    // 1. Pane: a split's pane closes alone.
    const a = await shell(join(dir, 'pane'));
    const split = await source.paneSplit({ sessionId: a.id, direction: 'right' });
    const splitResult = await source.stop(split.sessionId, {});
    say('pane close', splitResult);
    check(splitResult.status === 'closed' && !(await paneIds()).includes(split.paneId), 'split pane closes alone');

    // 2. Tab: the last pane of a tab asks first, then closes the tab.
    const tabAsk = await source.stop(a.id, {});
    say('tab ask', tabAsk);
    check(tabAsk.status === 'confirmationRequired' && tabAsk.scope === 'tab', 'last pane in its tab asks for the tab');
    const tabClosed = await source.stop(a.id, { confirmedScope: 'tab' });
    say('tab close', tabClosed);
    check(tabClosed.status === 'closed' && (await workspaceOf(a)) === undefined, 'confirmed tab close closes the tab');

    // 3. Workspace: the last tab asks for the workspace, then closes it.
    const c = await shell(join(dir, 'workspace'));
    await closeOtherTabs(c);
    const cWorkspace = (await workspaceOf(c)).workspaceId;
    const workspaceAsk = await source.stop(c.id, { confirmedScope: 'tab' });
    say('workspace ask', workspaceAsk);
    check(workspaceAsk.status === 'confirmationRequired' && workspaceAsk.scope === 'workspace', 'last tab asks for the workspace');
    const workspaceClosed = await source.stop(c.id, { confirmedScope: 'workspace' });
    say('workspace close', workspaceClosed);
    check(workspaceClosed.status === 'closed' && !(await tree()).some((w) => w.workspaceId === cWorkspace), 'confirmed workspace close closes it');

    // 4. Worktree group root: asks for the group by repo name and size, then closes the whole group.
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Umer', '-c', 'user.email=umer@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
    const root = await shell(repo);
    const linked = await shell(repo, { worktree: { branch: `close-lab-${process.pid}` } });
    await closeOtherTabs(root);
    const group = [(await workspaceOf(root)).workspaceId, (await workspaceOf(linked)).workspaceId];
    const groupAsk = await source.stop(root.id, { confirmedScope: 'workspace' });
    say('group ask', groupAsk);
    check(groupAsk.status === 'confirmationRequired' && groupAsk.scope === 'worktreeGroup'
        && /2 workspaces in this worktree group/.test(groupAsk.message ?? ''), 'group root asks for its worktree group');
    const groupClosed = await source.stop(root.id, { confirmedScope: 'worktreeGroup' });
    say('group close', groupClosed);
    const left = (await tree()).map((w) => w.workspaceId);
    check(groupClosed.status === 'closed' && group.every((id) => !left.includes(id)), 'confirmed group close closes the root and its linked checkout');
} finally {
    await source.dispose();
}
console.log(failed ? 'FAIL herdrCloseLab' : 'PASS herdrCloseLab');
process.exit(failed ? 1 : 0);
