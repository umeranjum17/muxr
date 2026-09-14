/** Pure projection of the host's Herdr tree into repository navigation. */
import type { AgentLifecycle, HerdrTreePane, HerdrTreeWorkspace } from '@muxr/contract';

const RECENT_MS = 24 * 60 * 60 * 1_000;

export function workspaceName(ws: HerdrTreeWorkspace): string {
    const clean = ws.label?.replace(/\s*[·•|]\s*p:[^\s]+\s*$/, '').trim();
    if (!clean) return 'Untitled space';
    return clean.includes('/') ? clean.split('/').filter(Boolean).pop() ?? 'Untitled space' : clean;
}

export function hasAgent(ws: HerdrTreeWorkspace): boolean {
    return ws.tabs.some((tab) => tab.panes.some((pane) => pane.agentKind !== undefined));
}

export function middleTruncate(value: string, max = 44): string {
    if (value.length <= max) return value;
    const half = Math.floor((max - 1) / 2);
    return `${value.slice(0, half)}…${value.slice(-half)}`;
}

export type PaneInSpace = { pane: HerdrTreePane; workspace: HerdrTreeWorkspace };
export type SpaceCounts = { agents: number; shells: number; blocked: number; failed: number; working: number; starting: number; recent: number; done: number };
export type HerdWorktreeRow = {
    key: string; title: string; branch?: string; path: string;
    workspaces: HerdrTreeWorkspace[]; panes: PaneInSpace[]; counts: SpaceCounts;
    expanded: boolean; selected: boolean; matchedPanes: number;
};
export type HerdRepoRow = {
    type: 'repository'; key: string; title: string; path: string; pathHint?: string;
    worktrees: HerdWorktreeRow[]; totalWorktrees: number; counts: SpaceCounts;
    selected: boolean;
};
export type HerdOtherRow = {
    type: 'workspace'; workspace: HerdrTreeWorkspace; panes: PaneInSpace[];
    counts: SpaceCounts; expanded: boolean; selected: boolean;
};
export type HerdRow = HerdRepoRow | HerdOtherRow;

export const checkoutDisclosureKey = (repoKey: string, checkoutKey: string) => `checkout:${repoKey}\0${checkoutKey}`;
export const workspaceDisclosureKey = (workspaceId: string) => `workspace:${workspaceId}`;

function paneEntries(workspaces: readonly HerdrTreeWorkspace[]): PaneInSpace[] {
    return workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes.map((pane) => ({ pane, workspace }))));
}

function countsOf(entries: readonly PaneInSpace[], now: number): SpaceCounts {
    const counts: SpaceCounts = { agents: 0, shells: 0, blocked: 0, failed: 0, working: 0, starting: 0, recent: 0, done: 0 };
    const routes = new Set<string>();
    const shellPanes = new Set<string>();
    for (const { pane } of entries) {
        if (pane.agentKind === undefined) {
            if (!shellPanes.has(pane.paneId)) counts.shells += 1;
            shellPanes.add(pane.paneId);
            continue;
        }
        if (pane.sessionId === undefined || routes.has(pane.sessionId)) continue;
        routes.add(pane.sessionId);
        counts.agents += 1;
        if (pane.agentStatus === 'blocked') counts.blocked += 1;
        if (pane.agentStatus === 'failed') counts.failed += 1;
        if (pane.agentStatus === 'working') counts.working += 1;
        if (pane.agentStatus === 'starting') counts.starting += 1;
        if (pane.agentStatus === 'done') counts.done += 1;
        if ((pane.agentStatus === 'done' || pane.agentStatus === 'idle')
            && pane.changedAt !== undefined && now >= pane.changedAt && now - pane.changedAt < RECENT_MS) counts.recent += 1;
    }
    return counts;
}

export function spaceSummary(counts: SpaceCounts, worktrees?: number): string {
    const parts = [worktrees === undefined ? `${counts.agents} agent${counts.agents === 1 ? '' : 's'}` : `${worktrees} worktree${worktrees === 1 ? '' : 's'}`];
    if (worktrees !== undefined && counts.agents) parts.push(`${counts.agents} agent${counts.agents === 1 ? '' : 's'}`);
    if (counts.blocked) parts.push(`${counts.blocked} needs you`);
    if (counts.failed) parts.push(`${counts.failed} failed`);
    if (counts.working) parts.push(`${counts.working} working`);
    if (counts.starting) parts.push(`${counts.starting} starting`);
    if (counts.recent) parts.push(`${counts.recent} recent`);
    else if (counts.done) parts.push(`${counts.done} done`);
    if (worktrees === undefined && counts.shells) parts.push(`${counts.shells} shell${counts.shells === 1 ? '' : 's'}`);
    return parts.join(' · ');
}

function rank(entries: readonly PaneInSpace[], now: number): number {
    const statuses: Record<AgentLifecycle, number> = { blocked: 0, failed: 1, working: 3, starting: 4, done: 6, idle: 8, unknown: 9 };
    return entries.reduce((best, { pane }) => {
        if (pane.agentKind === undefined) return best;
        const recent = pane.changedAt !== undefined && now >= pane.changedAt && now - pane.changedAt < RECENT_MS;
        return Math.min(best, statuses[pane.agentStatus] - (recent && pane.agentStatus === 'done' ? 1 : 0));
    }, 9);
}

function compareByAttention(left: { entries: PaneInSpace[]; title: string }, right: { entries: PaneInSpace[]; title: string }, selectedSessionId: string | undefined, now: number): number {
    const selected = (entries: readonly PaneInSpace[]) => entries.some(({ pane }) => pane.sessionId === selectedSessionId || pane.focused);
    return rank(left.entries, now) - rank(right.entries, now)
        || Number(selected(right.entries)) - Number(selected(left.entries))
        || left.title.localeCompare(right.title);
}

function matches(query: string, values: readonly (string | undefined)[]): boolean {
    return values.some((value) => value?.toLocaleLowerCase().includes(query));
}

function paneMatches(query: string, pane: HerdrTreePane): boolean {
    return matches(query, [pane.taskTitle, pane.agentName, pane.agentKind, pane.displayAgent, pane.label, pane.terminalTitle, pane.cwd]);
}

function worktreeTitle(workspaces: readonly HerdrTreeWorkspace[], repoName: string): string {
    const worktree = workspaces[0]?.worktree;
    const label = workspaces.length === 1 ? workspaceName(workspaces[0]!) : '';
    if (label && label !== 'Untitled space' && label !== repoName) return label;
    if (worktree?.branch) return worktree.branch.split('/').pop() ?? worktree.branch;
    return worktree?.isLinkedWorktree ? 'Detached worktree' : 'Main checkout';
}

/** Search reveals matching ancestors without changing the saved disclosure set. */
export function buildSpaceRows(
    workspaces: readonly HerdrTreeWorkspace[], expanded: ReadonlySet<string>, searchQuery: string,
    selectedSessionId?: string, now = Date.now(),
): HerdRow[] {
    const query = searchQuery.trim().toLocaleLowerCase();
    const repos = new Map<string, Map<string, HerdrTreeWorkspace[]>>();
    const other: HerdrTreeWorkspace[] = [];
    for (const workspace of workspaces) {
        const { repoKey, checkoutKey } = workspace.worktree ?? {};
        if (!repoKey || !checkoutKey) { other.push(workspace); continue; }
        const checkouts = repos.get(repoKey) ?? new Map<string, HerdrTreeWorkspace[]>();
        const group = checkouts.get(checkoutKey) ?? [];
        group.push(workspace);
        checkouts.set(checkoutKey, group);
        repos.set(repoKey, checkouts);
    }
    const repoRows: Array<HerdRepoRow & { entries: PaneInSpace[] }> = [];
    for (const [repoKey, checkouts] of repos) {
        const first = checkouts.values().next().value?.[0] as HerdrTreeWorkspace | undefined;
        const repoName = first?.worktree?.repo || 'Repository';
        const repoPath = first?.worktree?.repoPath ?? repoKey;
        const repoMatch = query !== '' && matches(query, [repoName, repoPath]);
        const allEntries = [...checkouts.values()].flatMap(paneEntries);
        const children: Array<HerdWorktreeRow & { entries: PaneInSpace[] }> = [];
        for (const [checkoutKey, group] of checkouts) {
            const entries = paneEntries(group);
            const title = worktreeTitle(group, repoName);
            const branch = group[0]?.worktree?.branch;
            const childMatch = repoMatch || (query !== '' && matches(query, [title, branch, checkoutKey, ...group.map(workspaceName)]));
            const matched = query === '' || childMatch ? entries : entries.filter(({ pane }) => paneMatches(query, pane));
            if (query !== '' && !childMatch && matched.length === 0) continue;
            const key = checkoutDisclosureKey(repoKey, checkoutKey);
            const isExpanded = query !== '' || expanded.has(key);
            children.push({
                key, title, branch, path: checkoutKey, workspaces: group,
                panes: isExpanded ? matched.sort((a, b) => compareByAttention({ entries: [a], title: a.pane.agentName ?? a.pane.label ?? '' }, { entries: [b], title: b.pane.agentName ?? b.pane.label ?? '' }, selectedSessionId, now)) : [],
                entries, counts: countsOf(entries, now), expanded: isExpanded,
                selected: entries.some(({ pane }) => pane.sessionId === selectedSessionId), matchedPanes: matched.length,
            });
        }
        if (query !== '' && children.length === 0) continue;
        children.sort((a, b) => compareByAttention(a, b, selectedSessionId, now));
        repoRows.push({
            type: 'repository', key: repoKey, title: repoName, path: repoPath,
            worktrees: children, totalWorktrees: checkouts.size, counts: countsOf(allEntries, now),
            selected: allEntries.some(({ pane }) => pane.sessionId === selectedSessionId), entries: allEntries,
        });
    }
    const names = new Map<string, number>();
    for (const checkouts of repos.values()) {
        const name = checkouts.values().next().value?.[0]?.worktree?.repo || 'Repository';
        names.set(name, (names.get(name) ?? 0) + 1);
    }
    for (const row of repoRows) if ((names.get(row.title) ?? 0) > 1) row.pathHint = row.path;
    repoRows.sort((a, b) => compareByAttention(a, b, selectedSessionId, now));
    const otherRows: HerdOtherRow[] = other.flatMap((workspace) => {
        const entries = paneEntries([workspace]);
        const name = workspaceName(workspace);
        const workspaceMatch = query !== '' && matches(query, [name, workspace.label, workspace.worktree?.path]);
        const matched = query === '' || workspaceMatch ? entries : entries.filter(({ pane }) => paneMatches(query, pane));
        if (query !== '' && !workspaceMatch && matched.length === 0) return [];
        const isExpanded = query !== '' || expanded.has(workspaceDisclosureKey(workspace.workspaceId));
        return [{ type: 'workspace', workspace, panes: isExpanded ? matched : [], counts: countsOf(entries, now), expanded: isExpanded,
            selected: entries.some(({ pane }) => pane.sessionId === selectedSessionId) }];
    });
    return [...repoRows, ...otherRows];
}
