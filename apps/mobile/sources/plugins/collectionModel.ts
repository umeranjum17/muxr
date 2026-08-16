import { capUtf8Bytes, sanitizeDisplayText, type PluginAction, type PluginScreenTone } from '@muxr/contract';

export interface PluginCollectionItem {
    id: string;
    title: string;
    subtitle?: string;
    icon?: string;
    glyph?: string;
    status?: PluginScreenTone;
    pulsing?: boolean;
    timestamp?: string;
    action: PluginAction;
}

export interface PluginCollectionGroup {
    id: string;
    title: string;
    items: PluginCollectionItem[];
}

export interface PluginCollectionModel {
    title?: string;
    groups: PluginCollectionGroup[];
}

const TONES = new Set<PluginScreenTone>(['primary', 'secondary', 'positive', 'warning', 'danger']);
const MAX_GROUPS = 24;
const MAX_ITEMS = 160;

function display(value: unknown, max: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const clean = capUtf8Bytes(sanitizeDisplayText(value), max).replace(/[\0-\x1F\x7F]/g, '').trim();
    return clean === '' ? undefined : clean;
}

function identifier(value: unknown): string | undefined {
    const clean = display(value, 64);
    return clean !== undefined && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(clean) ? clean : undefined;
}

function timestamp(value: unknown): string | undefined {
    const clean = display(value, 40);
    return clean !== undefined && Number.isFinite(Date.parse(clean)) ? new Date(clean).toISOString() : undefined;
}

/** Parse an untrusted read-RPC result into a bounded grouped collection. */
export function asPluginCollection(value: unknown, validateAction: (value: unknown) => PluginAction): PluginCollectionModel {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { groups: [] };
    const rawGroups = Array.isArray((value as { groups?: unknown }).groups) ? (value as { groups: unknown[] }).groups : [];
    let remaining = MAX_ITEMS;
    const groups = rawGroups.slice(0, MAX_GROUPS).flatMap((groupValue) => {
        if (groupValue === null || typeof groupValue !== 'object' || Array.isArray(groupValue)) return [];
        const group = groupValue as Record<string, unknown>;
        const id = display(group.id, 80);
        const title = display(group.title, 80);
        if (id === undefined || title === undefined) return [];
        const rawItems = Array.isArray(group.items) ? group.items : [];
        const items = rawItems.slice(0, remaining).flatMap((itemValue) => {
            if (itemValue === null || typeof itemValue !== 'object' || Array.isArray(itemValue)) return [];
            const item = itemValue as Record<string, unknown>;
            const itemId = display(item.id, 80);
            const titleText = display(item.title, 120);
            if (itemId === undefined || titleText === undefined) return [];
            try {
                const action = validateAction(item.action);
                const status = typeof item.status === 'string' && TONES.has(item.status as PluginScreenTone) ? item.status as PluginScreenTone : undefined;
                return [{
                    id: itemId,
                    title: titleText,
                    ...(display(item.subtitle, 240) === undefined ? {} : { subtitle: display(item.subtitle, 240) }),
                    ...(identifier(item.icon) === undefined ? {} : { icon: identifier(item.icon) }),
                    ...(display(item.glyph, 16) === undefined ? {} : { glyph: display(item.glyph, 16) }),
                    ...(status === undefined ? {} : { status }),
                    ...(item.pulsing === true ? { pulsing: true } : {}),
                    ...(timestamp(item.timestamp) === undefined ? {} : { timestamp: timestamp(item.timestamp) }),
                    action,
                }];
            } catch {
                return [];
            }
        });
        remaining -= items.length;
        return items.length === 0 ? [] : [{ id, title, items }];
    });
    return {
        ...(display((value as Record<string, unknown>).title, 80) === undefined ? {} : { title: display((value as Record<string, unknown>).title, 80) }),
        groups,
    };
}
