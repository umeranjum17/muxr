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

/** Agent Name only. Herdr's agent name is an internal route, not display identity. */
export function paneDisplayName(pane: HerdrTreePane): string {
    return pane.displayName?.trim() || 'Agent';
}

export function paneTaskTitle(pane: HerdrTreePane): string {
    return pane.taskTitle?.trim() || 'Untitled task';
}


/** Long cwd paths collapse around a midline ellipsis, like a shell prompt. */
export function middleTruncate(value: string, max = 44): string {
    if (value.length <= max) return value;
    const half = Math.floor((max - 1) / 2);
    return `${value.slice(0, half)}…${value.slice(-half)}`;
}

/** One workspace card in the Herd tab's spaces section. */
export type HerdSpaceRow = {
    type: 'workspace';
    workspace: HerdrTreeWorkspace;
    expanded: boolean;
    /** Agent panes only, for the "N agents" badge. */
    agentCount: number;
    /** Every pane this card lists when expanded (always empty when collapsed). */
    panes: HerdrTreePane[];
};

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
        query === '' || [pane.taskTitle, pane.displayName, pane.agentKind, pane.label]
            .some((value) => value !== undefined && value.toLocaleLowerCase().includes(query));

    const rows: HerdSpaceRow[] = [];
    for (const ws of workspaces) {
        const allPanes = ws.tabs.flatMap((tab) => tab.panes);
        const agents = allPanes.filter((pane) => pane.agentKind !== undefined);
        if (query !== '' && !allPanes.some(matches)) continue;

        const isExpanded = expanded.has(ws.workspaceId);
        rows.push({
            type: 'workspace',
            workspace: ws,
            expanded: isExpanded,
            agentCount: agents.length,
            panes: isExpanded ? allPanes.filter(matches) : [],
        });
    }
    return rows;
}
