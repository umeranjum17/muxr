export interface PaneChoice {
    id: string;
    name: string;
    kind: string;
    doing: string;
}

/**
 * Find the pane the user just named out loud.
 *
 * Speech gives names, never ids, and dictation mangles them ("the cursor
 * agent"), so this widens from an exact name to a partial one to kind. Every
 * match is returned rather than a best guess: the caller picks the voice
 * target or the working one, and asks when that still leaves more than one.
 */
export function spokenPaneQuery(query: string): string {
    return query.trim().toLowerCase().replace(/^the\s+/, '').replace(/\s+agents?$/, '').trim();
}

export function pickPane<T extends PaneChoice>(panes: T[], query: string): T[] {
    const wanted = spokenPaneQuery(query);
    if (wanted === '') return [];

    const byId = panes.filter((pane) => pane.id === query.trim());
    if (byId.length > 0) return byId;

    const lower = (pane: PaneChoice) => pane.name.trim().toLowerCase();
    for (const match of [
        (pane: PaneChoice) => lower(pane) === wanted,
        (pane: PaneChoice) => lower(pane).startsWith(wanted) || wanted.startsWith(lower(pane)),
        (pane: PaneChoice) => lower(pane).includes(wanted) || wanted.includes(lower(pane)),
        (pane: PaneChoice) => pane.kind.toLowerCase() === wanted,
        (pane: PaneChoice) => pane.doing.toLowerCase().includes(wanted),
    ]) {
        const found = panes.filter(match);
        if (found.length > 0) return found;
    }
    return [];
}
