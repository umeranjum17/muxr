import { MAX_CHART_LABEL_BYTES, MAX_CHART_SERIES, capUtf8Bytes, sanitizeDisplayText } from '@muxr/contract';
import type { UsageLimitsPayload, UsageLimitsVerdict, UsageLimitsWindow } from '@muxr/contract';

/** The limits vocabulary is the contract's own usage vocabulary; the parsers
 *  below bound it at the untrusted plugin boundary and are reused by typed
 *  host surfaces that render through the same primitives. */
export type PluginLimitsVerdict = UsageLimitsVerdict;
export type PluginLimitsWindow = UsageLimitsWindow;
export type PluginLimitsPayload = UsageLimitsPayload;

const VERDICTS = new Set<PluginLimitsVerdict>(['go', 'ahead', 'watch', 'low', 'limited']);
const PACES = new Set<NonNullable<PluginLimitsWindow['pace']>>(['limited', 'low', 'watch', 'ahead', 'on pace']);

const bounded = (value: unknown, bytes: number): string =>
    typeof value === 'string' ? capUtf8Bytes(sanitizeDisplayText(value).trim(), bytes) : '';

export { bounded as boundedText };

const finiteIn = (value: unknown, low: number, high: number): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;

/** Bounded quota windows: the exact shape the `limits` payload carries, shared
 *  by the payload parser and the Home card's connected strip. */
export function asLimitsWindows(value: unknown): PluginLimitsWindow[] {
    return (Array.isArray(value) ? value : []).flatMap((entry): PluginLimitsWindow[] => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
        const window = entry as Record<string, unknown>;
        const label = bounded(window.label, MAX_CHART_LABEL_BYTES);
        // A window without a usable share of the window is dropped, not guessed.
        if (label === '' || !finiteIn(window.used, 0, 100)) return [];
        const resetsIn = bounded(window.resetsIn, MAX_CHART_LABEL_BYTES);
        const name = bounded(window.window, 8);
        const elapsed = finiteIn(window.elapsed, 0, 1) ? window.elapsed : undefined;
        return [{
            label,
            used: window.used,
            ...(window.pace === null ? { pace: null }
                : typeof window.pace === 'string' && PACES.has(window.pace as NonNullable<PluginLimitsWindow['pace']>)
                    ? { pace: window.pace as NonNullable<PluginLimitsWindow['pace']> } : {}),
            ...(name === '' ? {} : { window: name }),
            ...(resetsIn === '' ? {} : { resetsIn }),
            ...(elapsed === undefined ? {} : { elapsed }),
        }];
    }).slice(0, MAX_CHART_SERIES);
}

/** Bound untrusted RPC limits data before it reaches the app-owned renderer. */
export function asLimitsPayload(value: unknown): PluginLimitsPayload {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { verdict: 'unknown', windows: [] };
    const raw = value as Record<string, unknown>;
    const verdict = typeof raw.verdict === 'string' && VERDICTS.has(raw.verdict as PluginLimitsVerdict)
        ? raw.verdict as PluginLimitsVerdict
        : 'unknown';
    const plan = bounded(raw.plan, 40);
    const message = bounded(raw.message, 160);
    const windows = asLimitsWindows(raw.windows);
    return {
        verdict,
        ...(plan === '' ? {} : { plan }),
        ...(message === '' ? {} : { message }),
        windows,
    };
}
