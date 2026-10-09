import { capUtf8Bytes, sanitizeDisplayText } from '@trymuxr/contract';
import { MAX_CHART_LABEL_BYTES, MAX_CHART_SERIES } from './screenModel';
import type { UsageLimitsPayload, UsageLimitsVerdict, UsageLimitsWindow } from '@trymuxr/contract';

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

/** Bound quota windows from an untrusted `limits` payload before rendering. */
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

/** Below this share of the window gone, a projection is noise, not a trend:
 *  a window that just opened says nothing about how it will end. */
const MIN_ELAPSED_FOR_PROJECTION = 0.01;

/** Seconds in the host's reset spelling ("16d 23h", "4h 11m", "45m"). */
export function resetSeconds(resetsIn: string | undefined): number | undefined {
    if (resetsIn === undefined) return undefined;
    let seconds = 0;
    for (const [, amount, unit] of resetsIn.matchAll(/(\d+)\s*([dhm])/g)) {
        seconds += Number(amount) * { d: 86_400, h: 3_600, m: 60 }[unit as 'd' | 'h' | 'm']!;
    }
    return seconds > 0 ? seconds : undefined;
}

/** How long until a window runs out at the pace so far, when that is before
 *  its reset; undefined while it outlasts the reset or cannot be projected.
 *  A window already out keeps the host's own verdict. */
export function runOutMs(window: PluginLimitsWindow): number | undefined {
    const elapsed = window.elapsed;
    if (elapsed === undefined || elapsed < MIN_ELAPSED_FOR_PROJECTION) return undefined;
    if (window.used <= 0 || window.used >= 100 || window.pace === 'limited') return undefined;
    if (window.used / elapsed <= 100) return undefined;
    const reset = resetSeconds(window.resetsIn);
    if (reset === undefined) return undefined;
    // At the pace so far the remaining share takes the same fraction of the
    // elapsed wall time as the share is of what was used when it was spent.
    return ((100 - window.used) / window.used) * (elapsed / (1 - elapsed)) * reset * 1_000;
}
