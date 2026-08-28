import { capUtf8Bytes, sanitizeDisplayText } from '@muxr/contract';

export interface RuntimeTreeItem {
    name: string;
    path: string;
    kind: 'folder' | 'file';
    children: RuntimeTreeItem[];
    hasChildren: boolean;
}

/** Accept bounded nested nodes or depth-safe flat `{ parent }` links from an RPC. */
export function asScreenTree(value: unknown): RuntimeTreeItem[] {
    if (!Array.isArray(value)) return [];
    const flat = value.some((entry) => typeof entry === 'object' && entry !== null && 'parent' in entry);
    if (flat) {
        const nodes = new Map<string, RuntimeTreeItem & { parent?: string }>();
        for (const entry of value) {
            if (nodes.size >= 512) break;
            if (typeof entry !== 'object' || entry === null) continue;
            const item = entry as Record<string, unknown>;
            const path = typeof item.path === 'string' ? capUtf8Bytes(sanitizeDisplayText(item.path), 1024) : '';
            const name = typeof item.name === 'string' ? capUtf8Bytes(sanitizeDisplayText(item.name), 120) : '';
            if (path === '' || name === '' || nodes.has(path)) continue;
            const parent = typeof item.parent === 'string' ? capUtf8Bytes(sanitizeDisplayText(item.parent), 1024) : undefined;
            nodes.set(path, { name, path, kind: item.kind === 'folder' ? 'folder' : 'file', children: [], hasChildren: item.hasChildren === true, ...(parent === undefined ? {} : { parent }) });
        }
        const roots: RuntimeTreeItem[] = [];
        for (const node of nodes.values()) {
            const parent = node.parent === undefined ? undefined : nodes.get(node.parent);
            if (parent === undefined || parent.kind !== 'folder') roots.push(node);
            else { parent.children.push(node); parent.hasChildren = true; }
        }
        return roots;
    }
    const budget = { count: 0 };
    const nested = (entries: unknown, depth: number): RuntimeTreeItem[] => {
        if (!Array.isArray(entries) || depth > 16) return [];
        const nodes: RuntimeTreeItem[] = [];
        for (const entry of entries) {
            if (budget.count >= 512) break;
            if (typeof entry !== 'object' || entry === null) continue;
            const item = entry as Record<string, unknown>;
            const path = typeof item.path === 'string' ? capUtf8Bytes(sanitizeDisplayText(item.path), 1024) : '';
            const name = typeof item.name === 'string' ? capUtf8Bytes(sanitizeDisplayText(item.name), 120) : '';
            if (path === '' || name === '') continue;
            budget.count += 1;
            const children = nested(item.children, depth + 1);
            nodes.push({ name, path, kind: item.kind === 'folder' || children.length > 0 ? 'folder' : 'file', children, hasChildren: item.hasChildren === true || children.length > 0 });
        }
        return nodes;
    };
    return nested(value, 0);
}
