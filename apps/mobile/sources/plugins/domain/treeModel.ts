import { capUtf8Bytes, sanitizeDisplayText, type PluginAction, type PluginScreenTone } from '@muxr/contract';

export interface PluginTreeAction {
    id: string;
    label: string;
    hint?: string;
    action: PluginAction;
}

export interface PluginTreeNode {
    id: string;
    title: string;
    subtitle?: string;
    icon?: string;
    glyph?: string;
    status?: PluginScreenTone;
    pulsing?: boolean;
    current?: boolean;
    action?: PluginAction;
    actions?: PluginTreeAction[];
    children?: PluginTreeNode[];
}

export interface PluginTreeModel {
    title?: string;
    nodes: PluginTreeNode[];
}

const TONES = new Set<PluginScreenTone>(['primary', 'secondary', 'positive', 'warning', 'danger']);
const MAX_NODES = 100;
const MAX_DEPTH = 6;
const MAX_ACTIONS = 8;

function display(value: unknown, max: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const clean = capUtf8Bytes(sanitizeDisplayText(value), max).replace(/[\0-\x1F\x7F]/g, '').trim();
    return clean === '' ? undefined : clean;
}

function identifier(value: unknown): string | undefined {
    const clean = display(value, 64);
    return clean !== undefined && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(clean) ? clean : undefined;
}

/** Parse an untrusted read-RPC result into a bounded recursive tree. */
export function asPluginTree(value: unknown, validateAction: (value: unknown) => PluginAction): PluginTreeModel {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { nodes: [] };
    const budget = { nodes: 0 };
    const parseNodes = (raw: unknown, depth: number): PluginTreeNode[] => {
        if (!Array.isArray(raw) || depth > MAX_DEPTH) return [];
        return raw.flatMap((nodeValue): PluginTreeNode[] => {
            if (budget.nodes >= MAX_NODES || nodeValue === null || typeof nodeValue !== 'object' || Array.isArray(nodeValue)) return [];
            const node = nodeValue as Record<string, unknown>;
            const id = display(node.id, 80);
            const title = display(node.title, 120);
            if (id === undefined || title === undefined) return [];
            let action: PluginAction | undefined;
            let actions: PluginTreeAction[] | undefined;
            try {
                if (node.action !== undefined) action = validateAction(node.action);
                if (Array.isArray(node.actions)) {
                    actions = node.actions.slice(0, MAX_ACTIONS).flatMap((entry) => {
                        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
                        const actionEntry = entry as Record<string, unknown>;
                        const actionId = display(actionEntry.id, 80);
                        const label = display(actionEntry.label, 80);
                        if (actionId === undefined || label === undefined) return [];
                        return [{
                            id: actionId,
                            label,
                            ...(display(actionEntry.hint, 160) === undefined ? {} : { hint: display(actionEntry.hint, 160) }),
                            action: validateAction(actionEntry.action),
                        }];
                    });
                    if (actions.length === 0) actions = undefined;
                }
            } catch {
                return [];
            }
            const status = typeof node.status === 'string' && TONES.has(node.status as PluginScreenTone) ? node.status as PluginScreenTone : undefined;
            budget.nodes += 1;
            const children = parseNodes(node.children, depth + 1);
            return [{
                id,
                title,
                ...(display(node.subtitle, 200) === undefined ? {} : { subtitle: display(node.subtitle, 200) }),
                ...(identifier(node.icon) === undefined ? {} : { icon: identifier(node.icon) }),
                ...(display(node.glyph, 16) === undefined ? {} : { glyph: display(node.glyph, 16) }),
                ...(status === undefined ? {} : { status }),
                ...(node.pulsing === true ? { pulsing: true } : {}),
                ...(node.current === true ? { current: true } : {}),
                ...(action === undefined ? {} : { action }),
                ...(actions === undefined ? {} : { actions }),
                ...(children.length === 0 ? {} : { children }),
            }];
        });
    };
    return {
        ...(display((value as Record<string, unknown>).title, 80) === undefined ? {} : { title: display((value as Record<string, unknown>).title, 80) }),
        nodes: parseNodes((value as Record<string, unknown>).nodes, 1),
    };
}
