/**
 * Pure helpers for the Herd tab's herdr-tree rendering (no react-native imports).
 */

import type { HerdrTreePane, HerdrTreeWorkspace } from '@muxr/contract';

/** A path label becomes its folder; anything else is already a name. */
export function workspaceName(ws: HerdrTreeWorkspace): string {
    const label = ws.label ?? ws.workspaceId;
    if (label.includes('/')) return label.split('/').filter(Boolean).pop() ?? label;
    return label;
}

export function hasAgent(ws: HerdrTreeWorkspace): boolean {
    return ws.tabs.some((tab) => tab.panes.some((pane) => pane.agentKind !== undefined));
}


/** Long cwd paths collapse around a midline ellipsis, like a shell prompt. */
export function middleTruncate(value: string, max = 44): string {
    if (value.length <= max) return value;
    const half = Math.floor((max - 1) / 2);
    return `${value.slice(0, half)}…${value.slice(-half)}`;
}

/** A pane with the tab it sits in: the tab's label is the name a person gave it. */
export type SpacePane = { pane: HerdrTreePane; tabLabel?: string };

export type SpaceGroupKey = 'attention' | 'working' | 'done' | 'shells';

/**
 * One state group inside a workspace card. Agents group by the lifecycle
 * the tree already carries; shells group by kind, because a shell has no
 * lifecycle to act on and listing it under "done" or "idle" would put a
 * terminal between finished agents.
 */
export type SpaceGroup = {
    key: SpaceGroupKey;
    title: string;
    panes: SpacePane[];
    /** The noisy history folds away; the attention group never does. */
    foldedByDefault: boolean;
};

/** One workspace card in the Herd tab's spaces section. */
export type HerdSpaceRow = {
    type: 'workspace';
    workspace: HerdrTreeWorkspace;
    expanded: boolean;
    /** Agent panes only, for the "N agents" badge. */
    agentCount: number;
    /** Every pane this card lists when expanded (always empty when collapsed). */
    panes: HerdrTreePane[];
    /** The same panes, attention first, then working, then the folded rest. */
    groups: SpaceGroup[];
};

export function isShellPane(pane: HerdrTreePane): boolean {
    const named = pane.agentName?.trim();
    const kind = pane.agentKind?.trim();
    return !(named !== undefined && named !== '' || kind !== undefined && kind !== '');
}

function spaceGroupKey(pane: HerdrTreePane): SpaceGroupKey {
    if (isShellPane(pane)) return 'shells';
    switch (pane.agentStatus) {
        case 'blocked':
        case 'failed':
            return 'attention';
        case 'working':
        case 'starting':
            return 'working';
        default:
            return 'done';
    }
}

const GROUP_ORDER: readonly { key: SpaceGroupKey; title: string; folds: boolean }[] = [
    { key: 'attention', title: 'Needs you', folds: false },
    { key: 'working', title: 'Working', folds: false },
    { key: 'done', title: 'Done', folds: true },
    { key: 'shells', title: 'Shells', folds: true },
];

/** Attention first, then working, then everything else; the first group is always open. */
export function groupSpacePanes(panes: readonly SpacePane[]): SpaceGroup[] {
    const groups = GROUP_ORDER
        .map((entry) => ({ key: entry.key, title: entry.title, folds: entry.folds, panes: panes.filter((item) => spaceGroupKey(item.pane) === entry.key) }))
        .filter((entry) => entry.panes.length > 0);
    return groups.map(({ key, title, folds, panes: members }, index) => ({ key, title, panes: members, foldedByDefault: folds && index > 0 }));
}

/** The one line that answers "do I need to act" before any row is read. */
export function spacesVerdict(workspaces: readonly HerdrTreeWorkspace[]): { blocked: number; failed: number; working: number; text: string } {
    let blocked = 0, failed = 0, working = 0;
    for (const ws of workspaces) for (const tab of ws.tabs) for (const pane of tab.panes) {
        if (isShellPane(pane)) continue;
        if (pane.agentStatus === 'blocked') blocked += 1;
        else if (pane.agentStatus === 'failed') failed += 1;
        else if (pane.agentStatus === 'working' || pane.agentStatus === 'starting') working += 1;
    }
    const parts: string[] = [];
    if (blocked > 0) parts.push(`${blocked} need${blocked === 1 ? 's' : ''} you`);
    if (failed > 0) parts.push(`${failed} failed`);
    if (parts.length === 0) parts.push('Nothing needs you');
    if (working > 0) parts.push(`${working} working`);
    return { blocked, failed, working, text: parts.join(' · ') };
}

export type HerdRow = HerdSpaceRow;

/**
 * Flatten the workspace tree into the Herd tab's spaces section: one card per
 * workspace; expanded cards list EVERY pane, shells included — a shell you
 * cannot see is a shell you cannot close. The live agent cards above the list
 * are the agents view — there is deliberately no separate agents section. A
 * non-empty `searchQuery` filters to workspaces with matching panes.
 */
export function buildSpaceRows(
    workspaces: HerdrTreeWorkspace[],
    expanded: ReadonlySet<string>,
    searchQuery: string,
): HerdSpaceRow[] {
    const query = searchQuery.trim().toLocaleLowerCase();
    const matches = (pane: HerdrTreePane): boolean =>
        query === '' || [pane.taskTitle, pane.agentName, pane.agentKind, pane.label]
            .some((value) => value !== undefined && value.toLocaleLowerCase().includes(query));

    const rows: HerdSpaceRow[] = [];
    for (const ws of workspaces) {
        const allPanes = ws.tabs.flatMap((tab) => tab.panes);
        const agentRoutes = new Set(allPanes.flatMap((pane) =>
            pane.agentKind === undefined || pane.sessionId === undefined ? [] : [pane.sessionId]));
        if (query !== '' && !allPanes.some(matches)) continue;

        const isExpanded = expanded.has(ws.workspaceId);
        const listed = isExpanded
            ? ws.tabs.flatMap((tab) => tab.panes.filter(matches).map((pane) => ({ pane, ...(tab.label === undefined ? {} : { tabLabel: tab.label }) })))
            : [];
        rows.push({
            type: 'workspace',
            workspace: ws,
            expanded: isExpanded,
            agentCount: agentRoutes.size,
            panes: listed.map((item) => item.pane),
            groups: groupSpacePanes(listed),
        });
    }
    return rows;
}
