/**
 * Pure helpers for the Herd tab's herdr-tree rendering (no react-native imports).
 */

import type { HerdrTreePane, HerdrTreeWorkspace } from '@muxr/contract';

/** Herdr's label, verbatim — never parsed, split or stripped (spaces.md §4.1). */
export function workspaceName(ws: HerdrTreeWorkspace): string {
    return ws.label ?? ws.workspaceId;
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

function declaredParent(ws: HerdrTreeWorkspace, byId: ReadonlyMap<string, HerdrTreeWorkspace>): string | undefined {
    const token = ws.tokens?.parent;
    if (token !== undefined && token !== ws.workspaceId && byId.has(token)) return token;
    // Herdr's worktree group: a linked checkout's parent is the unlinked
    // checkout of the same repo. Both declarations are data Herdr or the
    // producer wrote down; the label is never parsed.
    if (ws.worktree?.linked === true && ws.worktree.repoKey !== undefined) {
        // Several unlinked checkouts can share a repoKey; the lowest-order one
        // wins so a resnapshot cannot move the child to another card.
        let best: HerdrTreeWorkspace | undefined;
        for (const candidate of byId.values()) {
            if (candidate.workspaceId !== ws.workspaceId
                && candidate.worktree?.linked === false
                && candidate.worktree?.repoKey === ws.worktree.repoKey
                && (best === undefined
                    || (candidate.order ?? Number.MAX_SAFE_INTEGER) < (best.order ?? Number.MAX_SAFE_INTEGER))) best = candidate;
        }
        return best?.workspaceId;
    }
    return undefined;
}

/**
 * The workspace's ROOT ancestor — following a producer `parent` token, else
 * Herdr's worktree group, up to the first workspace that declares no parent
 * of its own. Never derived from the label. Every descendant therefore lands
 * under a top-level card's group row, and a cycle or self-reference anywhere
 * up the chain resolves to none, so nothing is hidden.
 */
export function parentOf(ws: HerdrTreeWorkspace, byId: ReadonlyMap<string, HerdrTreeWorkspace>): string | undefined {
    let root = declaredParent(ws, byId);
    if (root === undefined) return undefined;
    const seen = new Set([ws.workspaceId, root]);
    let current = byId.get(root);
    while (current !== undefined) {
        const next = declaredParent(current, byId);
        if (next === undefined) return root;
        if (seen.has(next)) return undefined;
        seen.add(next);
        root = next;
        current = byId.get(next);
    }
    return root;
}

/** One child workspace folded inside its parent's card (drawn by the card). */
export type HerdChildSpace = {
    workspace: HerdrTreeWorkspace;
    /** Agent panes, listed when the child expands in place. */
    panes: HerdrTreePane[];
    expanded: boolean;
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
    /** Children folded inside this card, in creation order. */
    children: HerdChildSpace[];
};

/** Counts behind a group row's summary: needs you, working, done. */
export function groupSummaryCounts(children: readonly HerdChildSpace[]): { needsYou: number; working: number; done: number } {
    const counts = { needsYou: 0, working: 0, done: 0 };
    for (const { workspace } of children) {
        if (workspace.agentStatus === 'blocked') counts.needsYou += 1;
        else if (workspace.agentStatus === 'working') counts.working += 1;
        else if (workspace.agentStatus === 'done') counts.done += 1;
    }
    return counts;
}

/** The children's shared producer `kind` token ("task"), or none when they disagree. */
export function groupKind(children: readonly HerdChildSpace[]): string | undefined {
    const kinds = new Set(children.map(({ workspace }) => workspace.tokens?.kind));
    return kinds.size === 1 && !kinds.has(undefined) ? [...kinds][0] : undefined;
}

/** Sheet expansion seeds: the workspace itself; a child opens its parent card instead of itself. */
export function spaceExpansionDefaults(workspaces: HerdrTreeWorkspace[], workspaceId: string): string[] {
    const byId = new Map(workspaces.map((ws) => [ws.workspaceId, ws] as const));
    const ws = byId.get(workspaceId);
    const parent = ws === undefined ? undefined : parentOf(ws, byId);
    return parent === undefined ? [workspaceId] : [parent, `child:${workspaceId}`];
}

/**
 * Flatten the workspace tree into the Herd tab's spaces section: one card per
 * top-level workspace; expanded cards list EVERY pane, shells included — a
 * shell you cannot see is a shell you cannot close. Workspaces with a declared
 * parent (spaces.md §4.2) fold behind their parent's group row and never
 * appear at the top level; with no lineage declared anywhere the list is flat,
 * in Herdr's creation order. A non-empty `searchQuery` filters cards to
 * workspaces with matching labels or panes; a matching child keeps its parent,
 * whose card opens.
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
    const labelMatches = (ws: HerdrTreeWorkspace): boolean =>
        query !== '' && ws.label !== undefined && ws.label.toLocaleLowerCase().includes(query);

    const byId = new Map(workspaces.map((ws) => [ws.workspaceId, ws] as const));
    // Herdr's creation order; a workspace Herdr did not number sorts last, in snapshot order.
    const order = [...workspaces].sort((a, b) =>
        (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));

    const childrenOf = new Map<string, HerdrTreeWorkspace[]>();
    const topLevel: HerdrTreeWorkspace[] = [];
    for (const ws of order) {
        const parent = parentOf(ws, byId);
        if (parent === undefined) topLevel.push(ws);
        else {
            const siblings = childrenOf.get(parent);
            if (siblings === undefined) childrenOf.set(parent, [ws]);
            else siblings.push(ws);
        }
    }

    const searching = query !== '';
    const toChild = (child: HerdrTreeWorkspace): HerdChildSpace => {
        const agentPanes = child.tabs.flatMap((tab) => tab.panes).filter((pane) => pane.agentKind !== undefined);
        // Only a child with several agents expands in place; one agent is already
        // its own row's line 2 and its tap target (spaces.md §4.1).
        const childExpanded = agentPanes.length > 1 && expanded.has(`child:${child.workspaceId}`);
        return {
            workspace: child,
            panes: childExpanded ? agentPanes.filter(matches) : [],
            expanded: childExpanded,
        };
    };

    const rows: HerdSpaceRow[] = [];
    for (const ws of topLevel) {
        const allPanes = ws.tabs.flatMap((tab) => tab.panes);
        const children = (childrenOf.get(ws.workspaceId) ?? []).map(toChild);
        const visibleChildren = searching
            ? children.filter(({ workspace }) => labelMatches(workspace)
                || workspace.tabs.flatMap((tab) => tab.panes).some(matches))
            : children;
        if (searching && !labelMatches(ws) && !allPanes.some(matches) && visibleChildren.length === 0) continue;

        // A matching child forces its parent's card open.
        const isExpanded = expanded.has(ws.workspaceId) || (searching && visibleChildren.length > 0);
        const agentCount = new Set(allPanes.flatMap((pane) =>
            pane.agentKind === undefined || pane.sessionId === undefined ? [] : [pane.sessionId])).size;
        rows.push({
            type: 'workspace',
            workspace: ws,
            expanded: isExpanded,
            agentCount,
            panes: isExpanded ? allPanes.filter(matches) : [],
            children: visibleChildren,
        });
    }
    return rows;
}
