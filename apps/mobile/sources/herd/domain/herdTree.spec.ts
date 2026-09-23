import { herdPanes } from './herd';
import { selectLiveTerminalCards } from '../application/liveTerminalOrder';
import { describe, expect, it, vi } from 'vitest';
import { buildSpaceRows, defaultExpandedSpaces, middleTruncate, parentOf, spaceExpansionDefaults, workspaceCloseMessage, workspaceName, workspaceNames, workspacePath } from './herdTree';
import type { HerdrTreePane as ContractPane, HerdrTreeTab, HerdrTreeWorkspace as ContractWorkspace } from '@muxr/contract';
import { agentIdentityLine, agentKindLabel, agentLabels, agentNameLine, isShellLabels } from './agentPresentation';

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
        expect(liveCards).toEqual([]);
        expect(agentLabels({ ...agent, terminalTitle: 'Animated working title' }).taskTitle).toBe('Review monitoring stability');
        expect(isShellLabels(labels)).toBe(false);
        expect(buildSpaceRows([ws('w2', 'repo-b', [tab('1', undefined, [shell])])], new Set(), '')[0])
            .toMatchObject({ agentCount: 0, expanded: false });
    });

    it('groups task workspaces behind their parent from declared lineage, never the label', () => {
        const mine = ws('w1', 'firstmate', [tab('t1', 'main', [agent])]);
        const byToken = { ...ws('w2', '└ opencode-extdir1 · p:8NwSBmQ5YerlAcFOBfSrqg', [tab('t2', undefined, [pane('p2', 'opencode', { agentName: 'donkey', agentStatus: 'idle' })])]), tokens: { parent: 'w1', kind: 'task' }, order: 2 };
        const byWorktree = { ...ws('w3', 'pock-design-system1', [tab('t3', undefined, [pane('p3', 'pi', { agentName: 'lemur', agentStatus: 'working' })])]), worktree: { repo: 'pockit', path: '/srv/wt/pock-design-system1', repoKey: 'pockit', linked: true }, order: 3 };
        const orphan = { ...ws('w4', 'closed-parent-task1', [tab('t4', undefined, [pane('p4', 'pi', { agentStatus: 'blocked' })])]), tokens: { parent: 'w-gone', kind: 'task' }, order: 4 };
        const shellWorkspace = { ...ws('w5', '/home/umer', [tab('t5', undefined, [shell])]), order: 5 };
        const workspaces = [shellWorkspace, orphan, byWorktree, byToken, mine];
        const byId = new Map(workspaces.map((entry) => [entry.workspaceId, entry] as const));
        expect(parentOf(byToken, byId)).toBe('w1');
        expect(parentOf(byWorktree, byId)).toBe(undefined);
        const primary = workspaces.find((entry) => entry.workspaceId === 'w1');
        const primaryWithWorktree = { ...primary!, worktree: { repo: 'pockit', path: '/home/umer/pockit', repoKey: 'pockit', linked: false } };
        const grouped = new Map([...byId, ['w1', primaryWithWorktree] as const]);
        expect(parentOf(byWorktree, grouped)).toBe('w1');

        const rows = buildSpaceRows(workspaces.map((entry) => entry.workspaceId === 'w1' ? primaryWithWorktree : entry), new Set(['w1']), '');
        expect(rows).toHaveLength(3);
        const [orphanRow, shells, card] = rows;
        expect(card!.workspace.workspaceId).toBe('w1');
        // The card header is the single disclosure: one key expands card,
        // subheader and children together; no group key exists any more.
        expect(card!.expanded).toBe(true);
        expect(card!.children.map((child) => child.workspace.workspaceId)).toEqual(['w2', 'w3']);
        expect(card!.agentCount).toBe(1);
        // Collapsed: children stay folded, nothing but the card key opens them.
        const collapsed = buildSpaceRows(workspaces.map((entry) => entry.workspaceId === 'w1' ? primaryWithWorktree : entry), new Set(), '');
        expect(collapsed.find((row) => row.workspace.workspaceId === 'w1')).toMatchObject({ expanded: false, panes: [] });
        expect(shells!.children).toEqual([]);
        expect(shells!.workspace.workspaceId).toBe('w5');
        // The orphan's parent points outside the tree: it stays top-level.
        expect(orphanRow!.workspace.workspaceId).toBe('w4');
        expect(orphanRow!.children).toEqual([]);
        const flat = buildSpaceRows([orphan, mine], new Set(), '');
        expect(flat).toHaveLength(2);
        expect(flat[1]!.children).toEqual([]);

        // Search: a matching child keeps its parent, whose card opens.
        const searched = buildSpaceRows(workspaces.map((entry) => entry.workspaceId === 'w1' ? primaryWithWorktree : entry), new Set(), 'extdir');
        expect(searched).toHaveLength(1);
        expect(searched[0]!.workspace.workspaceId).toBe('w1');
        expect(searched[0]!.expanded).toBe(true);
        expect(searched[0]!.children.map((child) => child.workspace.workspaceId)).toEqual(['w2']);
        expect(searched[0]!.panes).toEqual([]);
        // A search matching only the parent itself does not force cards open.
        const parentMatch = buildSpaceRows(workspaces.map((entry) => entry.workspaceId === 'w1' ? primaryWithWorktree : entry), new Set(), 'firstmate');
        expect(parentMatch[0]!.expanded).toBe(false);
        expect(buildSpaceRows(workspaces, new Set(), 'nimbus')).toEqual([]);
        // The sheet seeds: a child opens its parent card instead of itself.
        expect(spaceExpansionDefaults(workspaces, 'w2')).toEqual(['w1', 'child:w2']);
        expect(spaceExpansionDefaults(workspaces, 'w5')).toEqual(['w5']);
        // A one-agent child is its own row: the seed never unfolds that agent underneath it again.
        const seeded = buildSpaceRows(workspaces.map((entry) => entry.workspaceId === 'w1' ? primaryWithWorktree : entry), new Set(spaceExpansionDefaults(workspaces, 'w2')), '');
        const seededChild = seeded.find((row) => row.workspace.workspaceId === 'w1')!.children
            .find((child) => child.workspace.workspaceId === 'w2')!;
        expect(seededChild).toMatchObject({ expanded: false, panes: [] });
        // A child with several agents still unfolds them in place.
        const twoAgents = { ...byToken, tabs: [tab('t2', undefined, [pane('p2', 'opencode', { agentName: 'donkey' }), pane('p2b', 'pi', { agentName: 'lemur' })])] };
        const unfolded = buildSpaceRows([mine, twoAgents], new Set(['w1', 'child:w2']), '');
        expect(unfolded[0]!.children[0]!.panes.map((entry) => entry.paneId)).toEqual(['p2', 'p2b']);

        // Deep lineage nests under each spawner inside the root's card, depth-first, one step deeper per generation.
        const grandchild = { ...ws('w6', 'deep-task1', [tab('t6', undefined, [pane('p6', 'pi', { agentStatus: 'working' })])]), tokens: { parent: 'w2', kind: 'task' }, order: 6 };
        const sibling = { ...ws('w8', 'late-task1', []), tokens: { parent: 'w1', kind: 'task' }, order: 8 };
        const deep = [sibling, grandchild, byToken, mine];
        expect(parentOf(grandchild, new Map(deep.map((entry) => [entry.workspaceId, entry] as const)))).toBe('w1');
        const deepRows = buildSpaceRows(deep, new Set(['w1']), '');
        expect(deepRows.map((row) => row.workspace.workspaceId)).toEqual(['w1']);
        expect(deepRows[0]!.children.map(({ workspace, depth, last, rails, hasChildren }) => ({ id: workspace.workspaceId, depth, last, rails, hasChildren })))
            .toEqual([
                { id: 'w2', depth: 1, last: false, rails: [], hasChildren: true },
                // w2's rail carries on past its child to w8.
                { id: 'w6', depth: 2, last: true, rails: [true], hasChildren: false },
                { id: 'w8', depth: 1, last: true, rails: [], hasChildren: false },
            ]);
        // A search reaching only the grandchild keeps the chain above it and opens the card.
        const deepSearch = buildSpaceRows(deep, new Set(), 'deep-task');
        expect(deepSearch[0]!.expanded).toBe(true);
        expect(deepSearch[0]!.children.map((child) => child.workspace.workspaceId)).toEqual(['w2', 'w6']);

        // Two unlinked checkouts share a repoKey: the lowest-order one takes the child, whatever the snapshot order.
        const firstUnlinked = { ...primaryWithWorktree, order: 1 };
        const secondUnlinked = { ...ws('w7', 'pockit-again', []), worktree: { repo: 'pockit', path: '/home/umer/pockit2', repoKey: 'pockit', linked: false }, order: 7 };
        const pair = [secondUnlinked, byWorktree, firstUnlinked];
        expect(parentOf(byWorktree, new Map(pair.map((entry) => [entry.workspaceId, entry] as const)))).toBe('w1');
        expect(parentOf(byWorktree, new Map([...pair].reverse().map((entry) => [entry.workspaceId, entry] as const)))).toBe('w1');

        const closedParent = { ...byWorktree, tokens: { parent: 'w-gone', kind: 'task' } };
        const selfParent = { ...byWorktree, workspaceId: 'w9', tokens: { parent: 'w9', kind: 'task' } };
        const invalid = [firstUnlinked, closedParent, selfParent];
        const invalidById = new Map(invalid.map((entry) => [entry.workspaceId, entry] as const));
        expect(parentOf(closedParent, invalidById)).toBeUndefined();
        expect(parentOf(selfParent, invalidById)).toBeUndefined();
        expect(buildSpaceRows(invalid, new Set(), '').map((row) => row.workspace.workspaceId)).toEqual(['w1', 'w2', 'w9']);
        expect(spaceExpansionDefaults(invalid, 'w2')).toEqual(['w2']);
        expect(defaultExpandedSpaces(invalid)).toEqual(['w1', 'w2', 'w9']);
    });

    it('never hides a workspace, whatever lineage the producer declares', () => {
        const agentWs = (id: string, order: number, parent?: string) => ({
            ...ws(id, `task-${id}`, [tab(`t-${id}`, undefined, [pane(`p-${id}`, 'pi', { sessionId: `s-${id}` })])]),
            order,
            ...(parent === undefined ? {} : { tokens: { parent, kind: 'task' } }),
        });
        const messy = [
            agentWs('root', 1),
            agentWs('self', 2, 'self'),
            agentWs('orphan', 3, 'w-closed'),
            agentWs('cycA', 4, 'cycB'),
            agentWs('cycB', 5, 'cycA'),
            agentWs('belowCycle', 6, 'cycA'),
            agentWs('c1', 7, 'root'),
            agentWs('c2', 8, 'c1'),
            agentWs('c3', 9, 'c2'),
            agentWs('c4', 10, 'c3'),
            agentWs('c5', 11, 'c4'),
        ];
        const rows = buildSpaceRows([...messy].reverse(), new Set(), '');
        const rendered = rows.flatMap((row) => [row.workspace.workspaceId, ...row.children.map((child) => child.workspace.workspaceId)]);
        expect(rendered.sort()).toEqual(messy.map((entry) => entry.workspaceId).sort());
        // Self-reference, a closed parent and both cycle members are cards; the tail below a cycle nests.
        expect(rows.map((row) => row.workspace.workspaceId)).toEqual(['root', 'self', 'orphan', 'cycA', 'cycB']);
        expect(rows.find((row) => row.workspace.workspaceId === 'cycA')!.children.map((child) => child.workspace.workspaceId)).toEqual(['belowCycle']);
        expect(rows[0]!.children.map((child) => child.depth)).toEqual([1, 2, 3, 4, 5]);
        // A big family starts folded to its summary; small ones and lone agents open.
        expect(defaultExpandedSpaces(messy)).toEqual(['self', 'orphan', 'cycA', 'cycB']);
    });

    it('names workspaces the way a person would, never by id or correlator', () => {
        const named = (label: string | undefined, cwd?: string) => workspaceName({ workspaceId: 'w9', label, focused: false, agentStatus: 'idle', tabs: cwd === undefined ? [] : [tab('t', undefined, [pane('p', undefined, { cwd })])] } as ContractWorkspace);
        expect(named('└ pock-rightnow-card2 · p:JuMd64wBPNCZQwGE_cRd3Q')).toBe('pock-rightnow-card2');
        expect(named('Release notes · draft')).toBe('Release notes · draft');
        expect(named('/home/umer/firstmate')).toBe('firstmate');
        expect(named('~/code/muxr-cloud/')).toBe('muxr-cloud');
        expect(named('/home/umer')).toBe('Home folder');
        expect(named('/')).toBe('Root folder');
        expect(named(undefined, '/srv/app')).toBe('app');
        expect(named('   ')).toBe('Untitled workspace');
        const workspaces = [
            { ...ws('a', '/srv/client/app', []), order: 1 },
            { ...ws('b', '/home/umer/app', []), order: 2 },
            { ...ws('c', '   ', []), order: 3 },
            { ...ws('d', undefined, []), order: 4 },
            ws('e', 'Fix login · issue:ABCDEF1234567890', []),
        ];
        expect([...workspaceNames(workspaces).values()]).toEqual([
            'app · client', 'app · umer', 'Untitled workspace 1', 'Untitled workspace 2', 'Fix login · issue:ABCDEF1234567890',
        ]);
        const crowded = [...workspaces, ws('f', 'app · client', []), ws('g', 'Untitled workspace 1', [])];
        const names = workspaceNames(crowded);
        expect([...names.values()]).toEqual([
            'app · srv/client', 'app · umer', 'Untitled workspace 2', 'Untitled workspace 3',
            'Fix login · issue:ABCDEF1234567890', 'app · client', 'Untitled workspace 1',
        ]);
        expect(new Set(names.values()).size).toBe(crowded.length);
        expect(workspacePath(workspaces[0]!)).toBe('/srv/client/app');
        expect(buildSpaceRows(crowded, new Set(), '/srv/client/app').map((row) => row.workspace.workspaceId)).toEqual(['a']);
        expect(buildSpaceRows(crowded, new Set(), 'issue:ABCDEF1234567890').map((row) => row.workspace.workspaceId)).toEqual(['e']);
        expect(workspaceCloseMessage(workspaces[0]!, names.get('a')!)).toContain('"app · srv/client" workspace (/srv/client/app)');
        const review = ws('review', 'review', [tab('t', undefined, [pane('p', 'pi', { cwd: '/tmp' })])]);
        expect(workspaceCloseMessage(review, 'review')).toContain('"review" workspace (this host)');
        expect(workspaceCloseMessage({ ...review, worktree: { repo: 'app', path: '/srv/client/app' } }, 'review'))
            .toContain('"review" workspace (/srv/client/app)');
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
