/**
 * Pure helpers for the Herd tab's herdr-tree rendering (no react-native imports).
 */

import type { HerdrTreePane, HerdrTreeWorkspace } from '@muxr/contract';
import { t } from '@/text';

// A producer that drew its own tree into a flat list prefixes the label with
// box-drawing glyphs, and may append an opaque correlator (` · p:<22 chars>`).
// Spaces draws the tree itself and never shows an id, so both stay off screen.
const DRAWN_TREE_PREFIX = /^[\s└├│┌┬┴┼─╰╭]+/u;
const CORRELATOR_SUFFIX = /\s+·\s+p:[A-Za-z0-9_-]{22}$/;
const cleanLabel = (ws: HerdrTreeWorkspace): string =>
    (ws.label ?? '').replace(DRAWN_TREE_PREFIX, '').replace(CORRELATOR_SUFFIX, '').trim();

/** A path label as a person names the folder: its last segment, or Home/Root. */
function folderName(path: string): string | undefined {
    const bare = path.replace(/(.)\/+$/, '$1');
    if (bare === '/') return t('spacesTree.rootFolder');
    if (bare === '~' || bare === '/root' || /^\/(home|Users)\/[^/]+$/.test(bare)) return t('spacesTree.homeFolder');
    if (!bare.startsWith('/') && !bare.startsWith('~/')) return undefined;
    return bare.split('/').pop();
}

/**
 * The name a workspace goes by in Spaces: Herdr's label without a drawn tree
 * prefix or correlator, a path label as its folder, and a nameless workspace
 * by its first pane's folder. Never the workspace id.
 */
export function workspaceName(ws: HerdrTreeWorkspace): string {
    const label = cleanLabel(ws);
    if (label !== '') return folderName(label) ?? label;
    return folderName(workspacePath(ws) ?? '') ?? t('spacesTree.untitledWorkspace');
}

export function workspaceRootPath(ws: HerdrTreeWorkspace): string | undefined {
    const label = cleanLabel(ws);
    return folderName(label) === undefined ? ws.worktree?.path : label;
}

export function workspacePath(ws: HerdrTreeWorkspace): string | undefined {
    return workspaceRootPath(ws) ?? ws.tabs.flatMap((tab) => tab.panes).find((pane) => pane.cwd)?.cwd;
}

export function workspaceCloseMessage(ws: HerdrTreeWorkspace, name: string): string {
    return `Closes only the "${name}" workspace (${workspaceRootPath(ws) ?? 'this host'}) in herdr. If that would close its worktree group, nothing closes.`;
}

export function workspaceNames(workspaces: readonly HerdrTreeWorkspace[]): ReadonlyMap<string, string> {
    const names = new Map(workspaces.map((ws) => [ws.workspaceId, workspaceName(ws)]));
    const taken = new Set(names.values());
    const groups = new Map<string, HerdrTreeWorkspace[]>();
    for (const ws of workspaces) groups.set(names.get(ws.workspaceId)!, [...(groups.get(names.get(ws.workspaceId)!) ?? []), ws]);
    for (const [name, peers] of groups) {
        if (peers.length < 2) continue;
        for (const ws of peers) {
            const path = workspacePath(ws);
            if (name === t('spacesTree.untitledWorkspace') || path === undefined || folderName(path) !== name) continue;
            const parts = path.replace(/\/+$/, '').split('/');
            for (let depth = 2; depth <= parts.length; depth++) {
                const parent = parts.slice(-depth, -1).join('/');
                const candidate = `${name} · ${parent}`;
                if (taken.has(candidate) || peers.some((other) => other !== ws
                    && workspacePath(other)?.replace(/\/+$/, '').split('/').slice(-depth, -1).join('/') === parent)) continue;
                names.set(ws.workspaceId, candidate);
                taken.add(candidate);
                break;
            }
        }
        const unresolved = peers.filter((ws) => names.get(ws.workspaceId) === name);
        if (unresolved.length < 2) continue;
        for (const ws of unresolved.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))) {
            let number = 1;
            while (taken.has(`${name} ${number}`)) number++;
            const numbered = `${name} ${number}`;
            names.set(ws.workspaceId, numbered);
            taken.add(numbered);
        }
    }
    return names;
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
    if (token !== undefined) return token !== ws.workspaceId && byId.has(token) ? token : undefined;
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
 * The workspace that spawned this one — the producer's `parent` token, else
 * Herdr's worktree group — or none. A workspace on a lineage cycle has no
 * spawner, so every member of a cycle is a top-level card and nothing a cycle
 * touches is hidden; a workspace below a cycle still nests under its member.
 */
export function spawnerOf(ws: HerdrTreeWorkspace, byId: ReadonlyMap<string, HerdrTreeWorkspace>): string | undefined {
    const parent = declaredParent(ws, byId);
    const seen = new Set<string>();
    for (let current = parent; current !== undefined; ) {
        if (current === ws.workspaceId) return undefined;
        if (seen.has(current)) break;
        seen.add(current);
        const next = byId.get(current);
        current = next === undefined ? undefined : declaredParent(next, byId);
    }
    return parent;
}

/** The top-level card a workspace folds into: its spawner's spawner, up to one with none. */
export function parentOf(ws: HerdrTreeWorkspace, byId: ReadonlyMap<string, HerdrTreeWorkspace>): string | undefined {
    let root: string | undefined;
    for (let current = spawnerOf(ws, byId); current !== undefined; ) {
        root = current;
        const next = byId.get(current);
        current = next === undefined ? undefined : spawnerOf(next, byId);
    }
    return root;
}

/** One descendant folded inside its top-level card (drawn by the card). */
export type HerdChildSpace = {
    workspace: HerdrTreeWorkspace;
    /** Agent panes, listed when the child expands in place. */
    panes: HerdrTreePane[];
    expanded: boolean;
    /** 1 = spawned by the card's workspace, 2 = by one of those, and so on. */
    depth: number;
    /** The last of its siblings: its rail ends at this row. */
    last: boolean;
    /** Per ancestor depth (1..depth-1): whether that ancestor's rail carries on past this row. */
    rails: boolean[];
    /** Its own descendants follow directly below it. */
    hasChildren: boolean;
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
    /** Every descendant folded inside this card, depth-first in creation order. */
    children: HerdChildSpace[];
};

/** Counts behind a group summary: needs you, working, done. */
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

/** Sheet expansion seeds: the workspace itself; a child opens its card instead of itself. */
export function spaceExpansionDefaults(workspaces: HerdrTreeWorkspace[], workspaceId: string): string[] {
    const byId = new Map(workspaces.map((ws) => [ws.workspaceId, ws] as const));
    const ws = byId.get(workspaceId);
    const parent = ws === undefined ? undefined : parentOf(ws, byId);
    return parent === undefined ? [workspaceId] : [parent, `child:${workspaceId}`];
}

/** A card with more descendants than this starts folded to its one-line summary. */
export const OPEN_FAMILY_LIMIT = 3;

export function effectiveExpandedSpaces(defaults: readonly string[], choices: ReadonlyMap<string, boolean>): ReadonlySet<string> {
    const expanded = new Set(defaults);
    for (const [id, open] of choices) {
        if (open) expanded.add(id);
        else expanded.delete(id);
    }
    return expanded;
}

/** Live card defaults: open ones with agents or small families; fold families above the limit. */
export function defaultExpandedSpaces(workspaces: HerdrTreeWorkspace[]): string[] {
    const byId = new Map(workspaces.map((ws) => [ws.workspaceId, ws] as const));
    const family = new Map<string, number>();
    const cards: HerdrTreeWorkspace[] = [];
    for (const ws of workspaces) {
        const root = parentOf(ws, byId);
        if (root === undefined) cards.push(ws);
        else family.set(root, (family.get(root) ?? 0) + 1);
    }
    return cards.filter((ws) => {
        const size = family.get(ws.workspaceId) ?? 0;
        return (hasAgent(ws) || size > 0) && size <= OPEN_FAMILY_LIMIT;
    }).map((ws) => ws.workspaceId);
}

/**
 * Flatten the workspace tree into the Herd tab's spaces section: one card per
 * top-level workspace; expanded cards list EVERY pane, shells included — a
 * shell you cannot see is a shell you cannot close. A workspace with a
 * spawner (spaces.md §4.2) folds inside its top-level ancestor's card, listed
 * right under its spawner one step deeper, and never appears at the top
 * level; with no lineage declared anywhere the list is flat, in Herdr's
 * creation order. A non-empty `searchQuery` filters cards to workspaces with
 * matching names or panes; a matching descendant keeps the chain above it,
 * and its card opens.
 */
export function buildSpaceRows(
    workspaces: HerdrTreeWorkspace[],
    expanded: ReadonlySet<string>,
    searchQuery: string,
): HerdSpaceRow[] {
    const query = searchQuery.trim().toLocaleLowerCase();
    const searching = query !== '';
    const matches = (pane: HerdrTreePane): boolean =>
        query === '' || [pane.taskTitle, pane.agentName, pane.agentKind, pane.label]
            .some((value) => value !== undefined && value.toLocaleLowerCase().includes(query));
    const names = workspaceNames(workspaces);
    const selfMatches = (ws: HerdrTreeWorkspace): boolean =>
        (names.get(ws.workspaceId) ?? '').toLocaleLowerCase().includes(query)
        || ws.label?.toLocaleLowerCase().includes(query) === true
        || ws.tabs.some((tab) => tab.panes.some(matches));

    const byId = new Map(workspaces.map((ws) => [ws.workspaceId, ws] as const));
    // Herdr's creation order; a workspace Herdr did not number sorts last, in snapshot order.
    const order = [...workspaces].sort((a, b) =>
        (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));

    const childrenOf = new Map<string, HerdrTreeWorkspace[]>();
    const topLevel: HerdrTreeWorkspace[] = [];
    for (const ws of order) {
        const spawner = spawnerOf(ws, byId);
        if (spawner === undefined) {
            topLevel.push(ws);
            continue;
        }
        const siblings = childrenOf.get(spawner);
        if (siblings === undefined) childrenOf.set(spawner, [ws]);
        else siblings.push(ws);
    }

    const shown = new Map<string, boolean>();
    const subtreeShown = (ws: HerdrTreeWorkspace): boolean => {
        let answer = shown.get(ws.workspaceId);
        if (answer === undefined) {
            answer = !searching || selfMatches(ws) || (childrenOf.get(ws.workspaceId) ?? []).some(subtreeShown);
            shown.set(ws.workspaceId, answer);
        }
        return answer;
    };

    const descendants = (workspaceId: string, depth: number, rails: boolean[]): HerdChildSpace[] => {
        const visible = (childrenOf.get(workspaceId) ?? []).filter(subtreeShown);
        return visible.flatMap((child, index) => {
            const last = index === visible.length - 1;
            const below = descendants(child.workspaceId, depth + 1, [...rails, !last]);
            const agentPanes = child.tabs.flatMap((tab) => tab.panes).filter((pane) => pane.agentKind !== undefined);
            // Only a child with several agents expands in place; one agent is already
            // its own row's line 2 and its tap target (spaces.md §4.1).
            const childExpanded = agentPanes.length > 1 && expanded.has(`child:${child.workspaceId}`);
            return [{
                workspace: child,
                panes: childExpanded ? agentPanes.filter(matches) : [],
                expanded: childExpanded,
                depth,
                last,
                rails,
                hasChildren: below.length > 0,
            }, ...below];
        });
    };

    const rows: HerdSpaceRow[] = [];
    for (const ws of topLevel) {
        if (!subtreeShown(ws)) continue;
        const allPanes = ws.tabs.flatMap((tab) => tab.panes);
        const children = descendants(ws.workspaceId, 1, []);

        // A matching descendant forces its card open.
        const isExpanded = expanded.has(ws.workspaceId) || (searching && children.length > 0);
        const agentCount = new Set(allPanes.flatMap((pane) =>
            pane.agentKind === undefined || pane.sessionId === undefined ? [] : [pane.sessionId])).size;
        rows.push({
            type: 'workspace',
            workspace: ws,
            expanded: isExpanded,
            agentCount,
            panes: isExpanded ? allPanes.filter(matches) : [],
            children,
        });
    }
    return rows;
}

export function displayedWorkspaceNames(rows: readonly HerdSpaceRow[]): ReadonlyMap<string, string> {
    return workspaceNames(rows.flatMap((row) => row.expanded
        ? [row.workspace, ...row.children.map((child) => child.workspace)]
        : [row.workspace]));
}
