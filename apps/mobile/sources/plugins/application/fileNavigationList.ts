import type { PluginItemListItem } from '../domain/itemListModel';

export interface FileNavigationEntry {
    path: string;
    title: string;
    subtitle?: string;
    group?: string;
    metadata: PluginItemListItem['metadata'];
}

let activeSessionId: string | undefined;
let entries: FileNavigationEntry[] = [];

/** Keep the last generic file list so a file viewer can continue the review. */
export function recordFileNavigation(sessionId: string, items: PluginItemListItem[], selectedPath: string): void {
    if (activeSessionId !== sessionId) {
        activeSessionId = sessionId;
        entries = [];
    }
    entries = items.flatMap((item) => {
        const action = item.action;
        if (action?.type !== 'kernel.navigate' || action.target !== 'file') return [];
        return [{
            path: action.path,
            title: item.title,
            ...(item.subtitle === undefined ? {} : { subtitle: item.subtitle }),
            ...(item.group === undefined ? {} : { group: item.group }),
            metadata: item.metadata,
        }];
    });
    if (!entries.some((entry) => entry.path === selectedPath)) entries = [];
}

export function currentFileNavigation(sessionId: string, path: string): { entries: FileNavigationEntry[]; index: number } | null {
    if (activeSessionId !== sessionId) return null;
    const index = entries.findIndex((entry) => entry.path === path);
    return index < 0 ? null : { entries, index };
}
