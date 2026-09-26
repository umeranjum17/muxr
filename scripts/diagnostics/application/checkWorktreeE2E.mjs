/** Real Herdr worktree session through an authenticated byokit device link. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { linkHerdrLab } from './linkHerdrLab.mjs';
import { requestLab } from './linkLabClient.mjs';

const root = mkdtempSync(join(tmpdir(), 'muxr-link-worktree-'));
const repo = join(root, 'repo');
const branch = `link-e2e-${process.pid}`;
mkdirSync(repo);
execFileSync('git', ['init', '-q'], { cwd: repo });
execFileSync('git', ['-c', 'user.name=link check', '-c', 'user.email=link-check@example.invalid',
    'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
let lab;
let workspaceId;
let checkoutRoot;
try {
    lab = await linkHerdrLab(root, 'worktree-e2e');
    const snap = await requestLab(lab.link, 'session.start', { cwd: repo, kind: 'pi', label: 'wt-test', worktree: { branch } });
    const id = snap?.info?.id;
    workspaceId = snap?.info?.workspaceId;
    const cwd = snap?.info?.cwd;
    if (typeof cwd !== 'string' || !cwd.includes(branch) || cwd === repo) throw new Error(`session cwd is not the worktree checkout: ${cwd}`);
    checkoutRoot = dirname(cwd);
    const deadline = Date.now() + 25_000;
    for (;;) {
        const list = await requestLab(lab.link, 'session.list');
        const found = list.find((session) => session.id === id);
        if (found?.cwd === cwd) break;
        if (Date.now() > deadline) throw new Error(`detected cwd drifted: ${found?.cwd}`);
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await requestLab(lab.link, 'session.stop', { sessionId: id });
    process.stdout.write('PASS e2e: worktree session over link\n');
} finally {
    if (lab !== undefined) {
        if (workspaceId !== undefined) {
            try { lab.herdr(['worktree', 'remove', '--workspace', workspaceId, '--force']); }
            catch { try { lab.herdr(['workspace', 'close', workspaceId]); } catch {} }
        }
        await lab.stop();
    }
    if (checkoutRoot !== undefined) rmSync(checkoutRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
}
