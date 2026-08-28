import { capUtf8Bytes, sanitizeDisplayText, type PluginAction, type PluginScreenTone } from '@muxr/contract';

export interface PluginItemMetadata {
    label?: string;
    value: string;
    tone?: PluginScreenTone;
}

export interface PluginItemProgress {
    value: number;
    tone?: PluginScreenTone;
}

export interface PluginItemListItem {
    id: string;
    title: string;
    subtitle?: string;
    icon?: string;
    /** Section name; items sharing a group render under one header, in first-seen order. */
    group?: string;
    /** Thin fill bar under the row, 0..1. */
    progress?: PluginItemProgress;
    metadata: PluginItemMetadata[];
    action?: PluginAction;
}

export interface PluginItemListBadge {
    value: string;
    tone?: PluginScreenTone;
}

export interface PluginItemListAction {
    id: string;
    label: string;
    icon?: string;
    action: PluginAction;
}

export interface PluginItemListModel {
    items: PluginItemListItem[];
    actions: PluginItemListAction[];
    badge?: PluginItemListBadge;
}

const TONES = new Set<PluginScreenTone>(['primary', 'secondary', 'positive', 'warning', 'danger']);

function tone(value: unknown): PluginScreenTone | undefined {
    return typeof value === 'string' && TONES.has(value as PluginScreenTone) ? value as PluginScreenTone : undefined;
}

function display(value: unknown, max: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const clean = capUtf8Bytes(sanitizeDisplayText(value), max).replace(/[\0-\x1F\x7F]/g, '').trim();
    return clean === '' ? undefined : clean;
}

function identifier(value: unknown): string | undefined {
    const clean = display(value, 64);
    return clean !== undefined && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(clean) ? clean : undefined;
}

function metadata(value: unknown): PluginItemMetadata[] {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 3).flatMap((entry) => {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const record = entry as Record<string, unknown>;
        const dataValue = display(record.value, 40);
        if (dataValue === undefined) return [];
        const label = display(record.label, 40);
        const entryTone = tone(record.tone);
        return [{ ...(label === undefined ? {} : { label }), value: dataValue, ...(entryTone === undefined ? {} : { tone: entryTone }) }];
    });
}

function progress(value: unknown): PluginItemProgress | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.value !== 'number' || !Number.isFinite(record.value)) return undefined;
    const clamped = Math.max(0, Math.min(1, record.value));
    const progressTone = tone(record.tone);
    return { value: clamped, ...(progressTone === undefined ? {} : { tone: progressTone }) };
}

function badge(value: unknown): PluginItemListBadge | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const badgeValue = display(record.value, 12);
    if (badgeValue === undefined) return undefined;
    const badgeTone = tone(record.tone);
    return { value: badgeValue, ...(badgeTone === undefined ? {} : { tone: badgeTone }) };
}

/** Parse one untrusted item-list RPC result into a bounded native model. */
export function asPluginItemList(value: unknown, validateAction: (value: unknown) => PluginAction): PluginItemListModel {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { items: [], actions: [] };
    const record = value as Record<string, unknown>;
    const rawItems = Array.isArray(record.items) ? record.items : [];
    const itemIds = new Set<string>();
    const items = rawItems.slice(0, 50).flatMap((entry) => {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const item = entry as Record<string, unknown>;
        const id = display(item.id, 255);
        const title = display(item.title, 255);
        if (id === undefined || title === undefined) return [];
        try {
            const action = item.action === undefined ? undefined : validateAction(item.action);
            if (itemIds.has(id)) return [];
            itemIds.add(id);
            const subtitle = display(item.subtitle, 512);
            const icon = identifier(item.icon);
            const group = display(item.group, 40);
            const itemProgress = progress(item.progress);
            return [{
                id,
                title,
                ...(subtitle === undefined ? {} : { subtitle }),
                ...(icon === undefined ? {} : { icon }),
                ...(group === undefined ? {} : { group }),
                ...(itemProgress === undefined ? {} : { progress: itemProgress }),
                metadata: metadata(item.metadata),
                ...(action === undefined ? {} : { action }),
            }];
        } catch {
            return [];
        }
    });
    const rawActions = Array.isArray(record.actions) ? record.actions : [];
    const actionIds = new Set<string>();
    const actions = rawActions.slice(0, 4).flatMap((entry) => {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const item = entry as Record<string, unknown>;
        const id = identifier(item.id);
        const label = display(item.label, 40);
        if (id === undefined || label === undefined) return [];
        try {
            const action = validateAction(item.action);
            if (actionIds.has(id)) return [];
            actionIds.add(id);
            const icon = identifier(item.icon);
            return [{ id, label, ...(icon === undefined ? {} : { icon }), action }];
        } catch {
            return [];
        }
    });
    const modelBadge = badge(record.badge);
    return { items, actions, ...(modelBadge === undefined ? {} : { badge: modelBadge }) };
}
