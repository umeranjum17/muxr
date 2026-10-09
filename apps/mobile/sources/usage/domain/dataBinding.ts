import { MAX_DISPLAY_BYTES, capUtf8Bytes, sanitizeDisplayText } from '@trymuxr/contract';

/** `{{data.dotted.path}}` bindings only; no expressions. Unresolved paths render empty. */
const BINDING = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

/** The screen data root binds under `data.*`; repeat entries bind under `item.*`. */
export function resolvePath(data: unknown, path: string, item?: unknown): unknown {
    let value: unknown;
    let segments: string;
    if (path.startsWith('item.')) {
        value = item;
        segments = path.slice(5);
    } else {
        value = data;
        segments = path.startsWith('data.') ? path.slice(5) : path;
    }
    for (const segment of segments.split('.')) {
        if (value === null || value === undefined) return undefined;
        if (typeof value !== 'object') return undefined;
        value = (value as Record<string, unknown>)[segment];
    }
    return value;
}

export function bindText(template: string, data: unknown, item?: unknown): string {
    if (!template.includes('{{')) {
        return capUtf8Bytes(sanitizeDisplayText(template), MAX_DISPLAY_BYTES);
    }
    const bound = template.replace(BINDING, (_match, path: string) => {
        const value = resolvePath(data, path, item);
        return value === undefined || value === null ? '' : String(value);
    });
    // Defensive: bound values come from the host already capped/sanitized, but
    // a template with several bindings can still exceed one display budget.
    return capUtf8Bytes(sanitizeDisplayText(bound), MAX_DISPLAY_BYTES);
}
