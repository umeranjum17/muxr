import type { PluginItemListItem } from '../domain/itemListModel';
import { registerPluginDataCacheInvalidator } from './pluginDataInvalidation';
import { shellQuote } from '@/utils/shellQuote';

export interface FileNavigationEntry {
    path: string;
    title: string;
    subtitle?: string;
    group?: string;
    icon?: string;
    metadata: PluginItemListItem['metadata'];
}

const MAX_ENTRIES = 50;
const MAX_COLLECTIONS = 16;

interface NavigationCollection {
    key: string;
    sessionId: string;
    sourceKey: string;
    entries: FileNavigationEntry[];
}

const collections = new Map<string, NavigationCollection>();
const sourceIndex = new Map<string, string>();

registerPluginDataCacheInvalidator((pluginIds) => {
    if (pluginIds === undefined) {
        collections.clear();
        sourceIndex.clear();
        return;
    }
    const affected = new Set(pluginIds);
    for (const [key, collection] of [...collections]) {
        const pluginId = collection.sourceKey.slice(0, collection.sourceKey.indexOf('\0'));
        if (!affected.has(pluginId)) continue;
        collections.delete(key);
        const sourceId = `${collection.sessionId}\0${collection.sourceKey}`;
        if (sourceIndex.get(sourceId) === key) sourceIndex.delete(sourceId);
    }
});

function evictOldest(): void {
    while (collections.size > MAX_COLLECTIONS) {
        const oldest = collections.keys().next().value;
        if (oldest === undefined) return;
        const removed = collections.get(oldest);
        collections.delete(oldest);
        if (removed === undefined) continue;
        const sourceId = `${removed.sessionId}\0${removed.sourceKey}`;
        if (sourceIndex.get(sourceId) === oldest) sourceIndex.delete(sourceId);
    }
}

function mintKey(): string {
    return `fn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Keep a source-scoped file list so a viewer can continue the review. */
export function recordFileNavigation(input: {
    sessionId: string;
    sourceKey: string;
    items: PluginItemListItem[];
    selectedPath: string;
}): string | undefined {
    const next: FileNavigationEntry[] = [];
    const seen = new Set<string>();
    for (const item of input.items) {
        if (next.length >= MAX_ENTRIES) break;
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
    if (!next.some((entry) => entry.path === input.selectedPath)) return undefined;
    const sourceId = `${input.sessionId}\0${input.sourceKey}`;
    const key = sourceIndex.get(sourceId) ?? mintKey();
    sourceIndex.set(sourceId, key);
    collections.delete(key);
    collections.set(key, { key, sessionId: input.sessionId, sourceKey: input.sourceKey, entries: next });
    evictOldest();
    return collections.has(key) ? key : undefined;
}

export function currentFileNavigation(
    sessionId: string,
    path: string,
    navigationKey?: string,
): { entries: FileNavigationEntry[]; index: number; key: string } | null {
    if (navigationKey === undefined) return null;
    const collection = collections.get(navigationKey);
    if (collection === undefined || collection.sessionId !== sessionId) return null;
    const index = collection.entries.findIndex((entry) => entry.path === path);
    return index < 0 ? null : { entries: collection.entries, index, key: navigationKey };
}

export function openFileViewer(input: {
    sessionId: string;
    path: string;
    navigation?: { key: string };
    line?: number;
    column?: number;
}): string {
    const params = new URLSearchParams({ path: input.path });
    if (input.navigation?.key) params.set('nav', input.navigation.key);
    if (input.line !== undefined && input.line > 0) params.set('line', String(input.line));
    if (input.column !== undefined && input.column > 0) params.set('column', String(input.column));
    return `/session/${encodeURIComponent(input.sessionId)}/file?${params}`;
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
