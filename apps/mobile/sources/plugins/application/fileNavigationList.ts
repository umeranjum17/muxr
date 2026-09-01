import type { PluginItemListItem } from '../domain/itemListModel';
import { shellQuote } from '@/utils/shellQuote';

export interface FileNavigationEntry {
    path: string;
    title: string;
    subtitle?: string;
    group?: string;
    icon?: string;
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
    const next: FileNavigationEntry[] = [];
    const seen = new Set<string>();
    for (const item of items) {
        const action = item.action;
        if (action?.type !== 'kernel.navigate' || action.target !== 'file') continue;
        if (seen.has(action.path)) continue;
        seen.add(action.path);
        next.push({
            path: action.path,
            title: item.title,
            ...(item.subtitle === undefined ? {} : { subtitle: item.subtitle }),
            ...(item.group === undefined ? {} : { group: item.group }),
            ...(item.icon === undefined ? {} : { icon: item.icon }),
            metadata: item.metadata,
        });
    }
    entries = next.some((entry) => entry.path === selectedPath) ? next : [];
}

export function currentFileNavigation(sessionId: string, path: string): { entries: FileNavigationEntry[]; index: number } | null {
    if (activeSessionId !== sessionId) return null;
    const index = entries.findIndex((entry) => entry.path === path);
    return index < 0 ? null : { entries, index };
}

export function parentDirectory(path: string): string | null {
    if (path === '/' || path === '') return null;
    const slash = path.lastIndexOf('/');
    if (slash < 0) return null;
    return slash === 0 ? '/' : path.slice(0, slash);
}

/** File directory first, then ancestors, then session cwd only if it is not already an ancestor. */
export function gitDirectorySearchPaths(filePath: string, sessionPath: string | null): string[] {
    let dir = parentDirectory(filePath);
    if (dir === null) return sessionPath ? [sessionPath] : ['/'];
    const paths: string[] = [];
    for (;;) {
        paths.push(dir);
        if (dir === '/') break;
        const next = parentDirectory(dir);
        if (next === null) break;
        dir = next;
    }
    if (sessionPath && !paths.includes(sessionPath)) paths.push(sessionPath);
    return paths;
}

export function gitDirectoryProbeCommand(filePath: string, sessionPath: string | null): string {
    const paths = gitDirectorySearchPaths(filePath, sessionPath);
    const listed = paths.map(shellQuote).join(' ');
    return `for d in ${listed}; do [ -d "$d" ] && { printf '%s' "$d"; exit 0; }; done; printf '%s' ${shellQuote(paths[paths.length - 1] ?? '/')}`;
}

/** Bundled changes rows mark binaries with value+secondary; a bare "binary" string is not Git status. */
export function bundledBinaryChip(metadata: FileNavigationEntry['metadata']): boolean {
    return metadata.some((item) => item.value === 'binary' && item.tone === 'secondary');
}

export function fileNavControlLabel(direction: 'previous' | 'next', title: string | undefined, index: number, total: number): string {
    const verb = direction === 'previous' ? 'Previous' : 'Next';
    if (title === undefined) return `${verb} changed file`;
    const ordinal = direction === 'previous' ? index : index + 2;
    return `${verb} changed file, ${title}, ${ordinal} of ${total}`;
}
