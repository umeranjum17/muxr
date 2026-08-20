import { MAX_CHART_LABEL_BYTES, MAX_CHART_SERIES, capUtf8Bytes, sanitizeDisplayText, type PluginScreenTone } from '@muxr/contract';

export interface PluginChartItem {
    label: string;
    value: number;
    valueLabel?: string;
    /** Second, quieter figure after the value: a reset time next to a percentage. */
    detail?: string;
    tone?: PluginScreenTone;
}

const TONES = new Set<PluginScreenTone>(['primary', 'secondary', 'positive', 'warning', 'danger']);

/** Bound untrusted RPC chart data before it reaches the app-owned renderer. */
export function asChartSeries(value: unknown): PluginChartItem[] {
    if (!Array.isArray(value)) return [];
    const items = value.flatMap((entry): PluginChartItem[] => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
        const raw = entry as Record<string, unknown>;
        const label = typeof raw.label === 'string'
            ? capUtf8Bytes(sanitizeDisplayText(raw.label).trim(), MAX_CHART_LABEL_BYTES)
            : '';
        if (label === '' || typeof raw.value !== 'number' || !Number.isFinite(raw.value) || raw.value < 0) return [];
        const valueLabel = typeof raw.valueLabel === 'string'
            ? capUtf8Bytes(sanitizeDisplayText(raw.valueLabel).trim(), MAX_CHART_LABEL_BYTES)
            : undefined;
        const detail = typeof raw.detail === 'string'
            ? capUtf8Bytes(sanitizeDisplayText(raw.detail).trim(), MAX_CHART_LABEL_BYTES)
            : undefined;
        const tone = typeof raw.tone === 'string' && TONES.has(raw.tone as PluginScreenTone)
            ? raw.tone as PluginScreenTone
            : undefined;
        return [{ label, value: raw.value, ...(valueLabel ? { valueLabel } : {}), ...(detail ? { detail } : {}), ...(tone ? { tone } : {}) }];
    }).slice(0, MAX_CHART_SERIES);
    return items.some((item) => item.value > 0) ? items : [];
}
