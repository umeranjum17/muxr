import { herdPanes } from './herd';
import { selectLiveTerminalCards } from '../application/liveTerminalOrder';
import { describe, expect, it, vi } from 'vitest';
import { buildSpaceRows, groupSpacePanes, middleTruncate, spacesVerdict, workspaceName } from './herdTree';
import type { HerdrTreePane as ContractPane, HerdrTreeTab, HerdrTreeWorkspace as ContractWorkspace } from '@muxr/contract';
import { agentIdentityLine, agentKindLabel, agentLabels, agentNameLine, isShellLabels, spaceRowLabels } from './agentPresentation';

const pane = (id: string, agentKind?: string, extra: Partial<ContractPane> = {}): ContractPane => ({ paneId: id, tabId: 't1', agentStatus: 'idle', promptable: false, focused: false, agentKind, ...extra });
const ws = (id: string, label: string | undefined, tabs: HerdrTreeTab[]): ContractWorkspace => ({ workspaceId: id, label, focused: false, agentStatus: 'idle', tabs });
const tab = (tabId: string, label: string | undefined, panes: ContractPane[]): HerdrTreeTab => ({ tabId, label, focused: false, agentStatus: 'idle', panes });
const agent = pane('p-a', 'pi', {
    sessionId: 's-a',
    cwd: '/home/umer/proj',
    agentName: 'Maria',
    taskTitle: 'Review monitoring stability',
});
const shell = pane('p-s', undefined, { cwd: '/tmp' });

describe('visible herd tree flow', () => {
    it('expands, collapses, and filters workspace cards without losing shell panes', () => {
        const workspaces = [ws('w1', 'repo-a', [tab('7', 'review', [agent, shell])])];
        const expanded = buildSpaceRows(workspaces, new Set(['w1']), '');
        expect(expanded).toHaveLength(1);
        expect(expanded[0]).toMatchObject({ type: 'workspace', agentCount: 1, expanded: true, panes: [agent, shell] });
        expect(buildSpaceRows(workspaces, new Set(), '')[0]).toMatchObject({ expanded: false, panes: [] });
        expect(buildSpaceRows(workspaces, new Set(['w1']), 'review monitoring')).toHaveLength(1);
        expect(buildSpaceRows(workspaces, new Set(['w1']), 'maria')).toHaveLength(1);
        expect(buildSpaceRows(workspaces, new Set(['w1']), 'beta')).toEqual([]);
        const labels = agentLabels(agent);
        expect({ primary: labels.taskTitle, secondary: labels.agentName, kind: labels.agentKind })
            .toEqual({ primary: 'Review monitoring stability', secondary: 'Maria', kind: 'pi' });
        expect(labels.taskTitle).not.toContain(labels.agentName);
        expect(agentNameLine(labels)).toBe('pi/Maria');
        expect(agentIdentityLine(labels)).toBe('pi/Maria');
        expect(agentLabels(pane('p-review', 'codex', { agentName: 'opus-review' }))).toMatchObject({
            taskTitle: 'opus-review',
            agentName: 'opus-review',
            agentKind: 'codex',
        });
        expect(agentNameLine(agentLabels(pane('p-review', 'codex', { agentName: 'opus-review' })))).toBe('codex');
        expect(agentNameLine(agentLabels(pane('p-fox', 'pi', { agentName: 'fox', taskTitle: 'Cursor Local Fast On' })))).toBe('pi/fox');
        expect(agentKindLabel('opencode')).toBe('OpenCode');
        expect(agentKindLabel('pi')).toBe('Pi');
        expect(agentLabels(pane('p-unnamed', 'opencode'))).toMatchObject({
            taskTitle: 'Unnamed agent',
            agentName: 'Unnamed agent',
            agentKind: 'opencode',
        });
        expect(agentLabels(shell)).toMatchObject({ taskTitle: 'tmp', agentName: 'Shell' });
        const titledShell = agentLabels(pane('p-titled-shell', undefined, { taskTitle: 'vim ~/.bashrc' }));
        expect(titledShell).toMatchObject({ taskTitle: 'vim ~/.bashrc', agentName: 'Shell' });
        expect(isShellLabels(titledShell)).toBe(true);
        const namedShell = pane('p-named', undefined, { sessionId: 'shell-route', label: 'Release browser', terminalTitle: 'umer@host:~/repo', cwd: '/repo' });
        expect(agentLabels(namedShell)).toMatchObject({ taskTitle: 'Release browser', agentName: 'Shell' });
        expect(agentNameLine(agentLabels(namedShell))).toBe('Shell');
        delete namedShell.label;
        expect(agentLabels(namedShell).taskTitle).toBe('umer@host:~/repo');
        const liveCards = selectLiveTerminalCards([], herdPanes([], [ws('w-shell', 'repo', [tab('t-shell', 'Tools', [namedShell])])]));
        expect(agentLabels(liveCards[0]).taskTitle).toBe('umer@host:~/repo');
        expect(agentLabels({ ...agent, terminalTitle: 'Animated working title' }).taskTitle).toBe('Review monitoring stability');
        expect(isShellLabels(labels)).toBe(false);
        expect(buildSpaceRows([ws('w2', 'repo-b', [tab('1', undefined, [shell])])], new Set(), '')[0])
            .toMatchObject({ agentCount: 0, expanded: false });
    });

    it('groups a workspace by the state it already tracks, attention first, and names rows by what a person called them', () => {
        const blocked = pane('p-b', 'claude', { sessionId: 's-b', agentName: 'ux_native', agentStatus: 'blocked', taskTitle: 'you-are-the-specialized-native-app', label: 'you-are-the-specialized-native-app' });
        const failed = pane('p-f', 'pi', { sessionId: 's-f', agentName: 'gate', agentStatus: 'failed', taskTitle: 'do-not-edit-files' });
        const working = pane('p-w', 'codex', { sessionId: 's-w', agentName: 'astra_director', agentStatus: 'working', taskTitle: 'you-are-astra-acting-as-read' });
        const done = pane('p-d', 'pi', { sessionId: 's-d', agentName: 'grouse', agentStatus: 'done', taskTitle: 'there-was-one-agent-working-on' });
        const shellA = pane('p-sa', undefined, { sessionId: 'sh-a', cwd: '/home/umer/.herdr/worktrees/pockit/feat-pwa-primary-channel', terminalTitle: 'umer@extreme:~/.herdr/worktrees/pockit/feat-pwa-primary-channel' });
        const shellB = pane('p-sb', undefined, { sessionId: 'sh-b', cwd: '/home/umer/.herdr/worktrees/pockit/feat-pwa-surfaces', terminalTitle: 'umer@extreme:~/.herdr/worktrees/pockit/feat-pwa-surfaces' });
        const workspaces = [ws('w1', 'pockit', [
            tab('t1', 'UX — native app', [blocked]),
            tab('t2', '1', [failed, done]),
            tab('t3', 'ASTRA — direction', [working]),
            tab('t4', 'pwa-build', [shellA]),
            tab('t5', undefined, [shellB]),
        ])];
        const [row] = buildSpaceRows(workspaces, new Set(['w1']), '');
        expect(row.groups.map((group) => [group.key, group.panes.map((item) => item.pane.paneId), group.foldedByDefault])).toEqual([
            ['attention', ['p-b', 'p-f'], false],
            ['working', ['p-w'], false],
            ['done', ['p-d'], true],
            ['shells', ['p-sa', 'p-sb'], true],
        ]);
        // A card whose first group is the noisy one still opens it.
        expect(groupSpacePanes([{ pane: done }, { pane: shellA }]).map((group) => group.foldedByDefault)).toEqual([false, true]);
        expect(spacesVerdict(workspaces)).toMatchObject({ blocked: 1, failed: 1, working: 1, text: '1 needs you · 1 failed · 1 working' });
        expect(spacesVerdict([ws('w2', 'quiet', [tab('t', 'x', [done, shellA])])]).text).toBe('Nothing needs you');
        // The tab's name leads; herdr's prompt-slug pane label is not a name; the prompt is the second line.
        expect(spaceRowLabels(blocked, 'UX — native app')).toEqual({ title: 'UX — native app', subtitle: 'claude/ux_native · you-are-the-specialized-native-app' });
        expect(spaceRowLabels(done, '1')).toEqual({ title: 'grouse', subtitle: 'pi · there-was-one-agent-working-on' });
        // Two shells in different worktrees never read the same: the path collapses around the middle, keeping the end.
        const a = spaceRowLabels(shellA, 'pwa-build');
        const b = spaceRowLabels(shellB);
        expect(a.title).toBe('pwa-build');
        expect(b.title).toBe('feat-pwa-surfaces');
        expect(a.subtitle).toMatch(/^Shell · ~\/\.herdr\/work.*primary-channel$/);
        expect(b.subtitle).toMatch(/pwa-surfaces$/);
        expect(a.subtitle).not.toBe(b.subtitle);
    });

    it('keeps workspace labels readable in the card and path UI', () => {
        expect(workspaceName({ workspaceId: 'w1', label: '/home/umer/repo-a', focused: false, agentStatus: 'idle', tabs: [] } as ContractWorkspace)).toBe('repo-a');
        expect(workspaceName({ workspaceId: 'w2', label: undefined, focused: false, agentStatus: 'idle', tabs: [] } as ContractWorkspace)).toBe('w2');
        expect(middleTruncate('short')).toBe('short');
        expect(middleTruncate('abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz', 20)).toBe('abcdefghi…rstuvwxyz');
    });
});

const installedBuild = vi.hoisted(() => ({ version: '0.1.26' as string | null, build: '356' as string | null }));
vi.mock('expo-application', () => ({ get nativeApplicationVersion() { return installedBuild.version; }, get nativeBuildVersion() { return installedBuild.build; } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '0.1.12' } } }));
import { getAppVersion, getAppBuildNumber } from '@/utils/appVersion';
import { versionsMismatch } from '@/utils/versionStatus';

it('reports installed app and host versions without confusing stale Expo metadata or release channels', () => {
    expect(getAppVersion()).toBe('0.1.26');
    expect(getAppBuildNumber()).toBe('356');
    expect(versionsMismatch(getAppVersion(), '0.1.26')).toBe(false);
    expect(versionsMismatch(getAppVersion(), '0.1.27-beta.1')).toBe(true);
    expect(versionsMismatch('0.1.27', '0.1.27-beta.1')).toBe(false);
    expect(versionsMismatch(getAppVersion(), 'muxr')).toBe(false);
    try {
        installedBuild.version = null; installedBuild.build = null;
        expect(getAppVersion()).toBe('0.1.12');
        expect(getAppBuildNumber()).toBeUndefined();
    } finally { installedBuild.version = '0.1.26'; installedBuild.build = '356'; }
});
