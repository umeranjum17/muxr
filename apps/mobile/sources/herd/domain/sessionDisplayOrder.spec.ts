import { describe, expect, it } from 'vitest';
import { buildActiveSessionDisplayGroups } from './sessionDisplayOrder';
import type { SessionRowData } from '@/sync/storage';

function row(over: Partial<SessionRowData>): SessionRowData {
    return {
        id: 'x', machineId: 'm', path: '/repo', homeDir: '/home/umer', workspaceId: 'w1', workspaceLabel: null,
        tabId: 'w1:t1', tabLabel: null, worktreeRepo: null, worktreeBranch: null, spawnedBy: null, createdAt: 0, ...over,
    } as SessionRowData;
}
const machines = [{ id: 'm', metadata: { displayName: 'extreme' } }];
const build = (rows: SessionRowData[]) => buildActiveSessionDisplayGroups(rows, machines, 'unknown')[0];

describe('active session display flow', () => {
    it('groups same-project sessions by tab and keeps shortcut order flat', () => {
        const group = build([
            row({ id: 'a', workspaceLabel: '/repo', tabId: 'w1:t1', tabLabel: 'pi' }),
            row({ id: 'b', workspaceLabel: '/repo', tabId: 'w1:t1', tabLabel: 'pi' }),
            row({ id: 'c', workspaceLabel: '/repo', tabId: 'w1:t2', tabLabel: 'review' }),
        ]);
        const project = [...group.projects.values()][0];
        expect(project.subgroups.map((subgroup) => subgroup.label)).toEqual(['pi', 'review']);
        expect(project.subgroups[0].sessions.map((session) => session.id)).toEqual(['a', 'b']);
        expect(project.sessions.map((session) => session.id)).toEqual(['a', 'b', 'c']);
        const numbered = [...build([row({ workspaceLabel: '/repo', tabLabel: '1' })]).projects.values()][0];
        expect(numbered.subgroups[0].label).toBeNull();
    });

    it('folds repo worktrees together without using spawn lineage as a grouping axis', () => {
        const group = build([
            row({ id: 'repo', worktreeRepo: 'myrepo', worktreeBranch: 'main', workspaceId: 'w1', workspaceLabel: 'myrepo', path: '/src/myrepo' }),
            row({ id: 'wt', worktreeRepo: 'myrepo', worktreeBranch: 'feature-x', workspaceId: 'w2', workspaceLabel: 'feature-x', path: '/worktrees/myrepo/feature-x' }),
            row({ id: 'worker', spawnedBy: 'repo', worktreeRepo: 'other-repo', worktreeBranch: 'settings-refactor', workspaceId: 'w9', workspaceLabel: 'settings-refactor', path: '/wt/settings-refactor' }),
        ]);
        expect(group.projects.size).toBe(2);
        const repo = [...group.projects.values()].find((project) => project.displayPath === 'myrepo')!;
        expect(repo.subgroups.map((subgroup) => subgroup.label)).toEqual(['main', 'feature-x']);
        expect(repo.subgroups.every((subgroup) => subgroup.isWorktree)).toBe(true);
        expect([...group.projects.values()].find((project) => project.displayPath === 'other-repo')?.subgroups[0].label).toBe('settings-refactor');
    });
});
