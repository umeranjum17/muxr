/**
 * The usage view model. Every provider's quota windows and every measured
 * activity figure map into these plain-data shapes, and every rendering
 * surface reads only from them -- no surface ever sees a provider's raw
 * payload, so no provider can put its own dialect on the screen.
 *
 * Dialects end here. Sources report "how much used" (Claude, Z.ai, Go) or
 * "how much left" (quota-style percentRemaining feeds); normalizeWindow
 * accepts either one dialect as input and derives the other, so the pair can
 * never disagree. One verdict rule governs the card and each window row.
 */

import type { UsageLimitsPayload, UsageLimitsWindow } from '@muxr/contract';
import { resetClock, WINDOW_MINUTES } from './rateLimits.js';

const clampPct = (value: number): number => Math.max(0, Math.min(100, value));

/** One uniform window. `used` and `remaining` are the two input dialects;
 * supply exactly one, the other comes back derived. Plain data throughout. */
interface PaceVerdict {
    verdict: 'limited' | 'low' | 'watch' | 'ahead' | 'on pace' | null;
    tone: 'danger' | 'warning' | 'secondary';
}

export interface UsageWindowVM {
    provider: string;
    windowKind: string;
    label: string;
    percentUsed: number;
    percentRemaining: number;
    windowMinutes?: number;
    resetEpochSec?: number;
    resetClock: string;
    limited?: boolean;
    pace: PaceVerdict;
}

export interface NormalizeWindowInput {
    provider: string;
    windowKind: string;
    label: string;
    used?: number | undefined;
    remaining?: number | undefined;
    windowMinutes?: number | undefined;
    resetEpochSec?: number | undefined;
    nowMs: number;
    limited?: boolean;
}

export function normalizeWindow({ provider, windowKind, label, used, remaining, windowMinutes, resetEpochSec, nowMs, limited = false }: NormalizeWindowInput): UsageWindowVM | undefined {
    const hasUsed = Number.isFinite(used);
    const hasRemaining = Number.isFinite(remaining);
    const percentUsed = clampPct(hasUsed ? used! : 100 - remaining!);
    if (!hasUsed && !hasRemaining) return undefined;
    const finiteMinutes = Number.isFinite(windowMinutes) && windowMinutes! > 0 ? windowMinutes! : undefined;
    const clock = resetClock(resetEpochSec, nowMs);
    const elapsed = windowElapsed(percentUsed, finiteMinutes, resetEpochSec, nowMs, clock);
    const verdict = elapsed === undefined ? null : limitsVerdict(percentUsed, elapsed, limited);
    return {
        provider,
        windowKind,
        label,
        percentUsed,
        // Derived, never independently sourced: one input dialect in, the
        // other computed, so a source cannot publish a contradictory pair.
        percentRemaining: 100 - percentUsed,
        ...(finiteMinutes === undefined ? {} : { windowMinutes: finiteMinutes }),
        ...(Number.isFinite(resetEpochSec) ? { resetEpochSec: resetEpochSec! } : {}),
        resetClock: clock,
        ...(limited ? { limited: true } : {}),
        pace: { verdict: verdict === 'go' ? 'on pace' : verdict, tone: verdict === 'limited' || verdict === 'low' ? 'danger' : verdict === 'ahead' || verdict === 'watch' ? 'warning' : 'secondary' },
    };
}

// --- Per-provider transforms: raw payload in, view models out. ---

/** One name per window kind, for every provider. The published length rides
 *  beside it as `window` ("5h", "7d"), so a label never spells it again. */
const KIND_LABELS: Record<string, string> = { session: 'Session', weekly: 'Weekly', monthly: 'Monthly' };

const CLAUDE_WINDOWS: [id: keyof typeof WINDOW_MINUTES, kind: string, label: string][] = [['five_hour', 'session', KIND_LABELS.session!], ['seven_day', 'weekly', KIND_LABELS.weekly!]];

/** Claude oauth/usage payload: `rate_limits.five_hour.utilization` is percent used. */
export function claudeWindows(raw: unknown, { provider = 'claude', nowMs }: { provider?: string; nowMs: number }): UsageWindowVM[] {
    const source = (raw as { rate_limits?: unknown } | undefined)?.rate_limits ?? raw;
    return CLAUDE_WINDOWS.flatMap(([id, kind, label]) => {
        const window = (source as Record<string, { utilization?: unknown; used_percentage?: unknown; resets_at?: unknown } | undefined> | undefined)?.[id];
        const used = percentUsedOf(window);
        const resetEpochSec = typeof window?.resets_at === 'number' ? window.resets_at : Date.parse(String(window?.resets_at)) / 1000;
        return [normalizeWindow({
            provider, windowKind: kind, label, used, windowMinutes: WINDOW_MINUTES[id],
            resetEpochSec, nowMs,
        })].filter((vm): vm is UsageWindowVM => vm !== undefined);
    });
}

function percentUsedOf(window: { utilization?: unknown; used_percentage?: unknown } | undefined): number | undefined {
    if (Number.isFinite(window?.utilization)) return window?.utilization as number;
    if (Number.isFinite(window?.used_percentage)) return window?.used_percentage as number;
    return undefined;
}

/** Z.ai monitor payload: `limits[].percentage` is percent used. */
export function zaiWindows(limits: unknown, { provider = 'zai', nowMs }: { provider?: string; nowMs: number }): UsageWindowVM[] {
    // Monitor buckets arrive as unit/number pairs; unknown pairs are skipped
    // rather than guessed at, so a schema change degrades to "unavailable".
    const windows = new Map([
        ['3:5', { kind: 'session', label: KIND_LABELS.session!, windowMinutes: WINDOW_MINUTES.five_hour }],
        ['6:1', { kind: 'weekly', label: KIND_LABELS.weekly!, windowMinutes: WINDOW_MINUTES.seven_day }],
    ]);
    return (Array.isArray(limits) ? limits : []).flatMap((limit): UsageWindowVM[] => {
        const entry = limit as { unit?: unknown; number?: unknown; percentage?: unknown; nextResetTime?: unknown } | null;
        const window = windows.get(`${entry?.unit}:${entry?.number}`);
        if (window === undefined) return [];
        return [normalizeWindow({
            provider, windowKind: window.kind, label: window.label, windowMinutes: window.windowMinutes,
            used: typeof entry?.percentage === 'number' ? entry.percentage : undefined,
            resetEpochSec: Number(entry?.nextResetTime) / 1000, nowMs,
        })].filter((vm): vm is UsageWindowVM => vm !== undefined);
    });
}

/** OpenCode Go payload: `usage[key].percent` is percent used, status marks rate limiting. */
export function goWindows(usage: unknown, { provider = 'opencode', nowMs }: { provider?: string; nowMs: number }): UsageWindowVM[] {
    // Rolling is documented as five hours and the weekly reset as Monday 00:00
    // UTC; the monthly anchor is the subscription date, so it publishes no
    // length and never claims a pace projection.
    const lengths: Record<'rolling' | 'weekly' | 'monthly', number | undefined> = { rolling: WINDOW_MINUTES.five_hour, weekly: WINDOW_MINUTES.weekly, monthly: undefined };
    const windowOf = (key: 'rolling' | 'weekly' | 'monthly') => (usage as Partial<Record<'rolling' | 'weekly' | 'monthly', { percent?: unknown; status?: unknown; resetsAt?: unknown }>> | undefined)?.[key];
    const GO_KEYS: ['rolling' | 'weekly' | 'monthly', string][] = [['rolling', 'Rolling'], ['weekly', 'Weekly'], ['monthly', 'Monthly']];
    return GO_KEYS.flatMap(([key, label]): UsageWindowVM[] => {
        const window = windowOf(key);
        if (!Number.isFinite(window?.percent) || (window?.percent as number) < 0 || !['ok', 'rate-limited'].includes(String(window?.status))) return [];
        return [normalizeWindow({
            provider, windowKind: key, label, used: window?.percent as number,
            windowMinutes: lengths[key], resetEpochSec: Date.parse(String(window?.resetsAt)) / 1000,
            nowMs, limited: window?.status === 'rate-limited',
        })].filter((vm): vm is UsageWindowVM => vm !== undefined);
    });
}

/** Codex app-server payload: windows carry usedPercent plus their own durations.
 *  A limit without a `limitName` is the plan's own, so its windows are named by
 *  kind alone; a separately named limit prefixes its name. */
export function codexWindows(limits: unknown[], { provider = 'codex', nowMs }: { provider?: string; nowMs: number }): UsageWindowVM[] {
    const kindForMinutes = (minutes: number | undefined): string =>
        minutes === WINDOW_MINUTES.five_hour ? 'session'
            : minutes === WINDOW_MINUTES.seven_day ? 'weekly'
                : minutes === WINDOW_MINUTES.monthly ? 'monthly' : 'custom';
    return limits.flatMap((limit) => ['primary', 'secondary'].flatMap((key): UsageWindowVM[] => {
        const window = (limit as Record<string, { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown } | undefined> | undefined)?.[key];
        if (!Number.isFinite(window?.usedPercent)) return [];
        const rawMinutes = window?.windowDurationMins;
        const windowMinutes = Number.isFinite(rawMinutes) && (rawMinutes as number) > 0 ? rawMinutes as number : undefined;
        const limitName = (limit as { limitName?: unknown }).limitName;
        const windowKind = kindForMinutes(windowMinutes);
        const kindLabel = KIND_LABELS[windowKind] ?? 'Limit';
        return [normalizeWindow({
            provider, windowKind,
            label: typeof limitName === 'string' && limitName !== '' ? `${limitName} · ${kindLabel}` : kindLabel,
            used: window?.usedPercent as number, windowMinutes, resetEpochSec: window?.resetsAt as number | undefined, nowMs,
        })].filter((vm): vm is UsageWindowVM => vm !== undefined);
    }));
}

// --- Measured activity: local session records in, totals out. ---

/** One measured model slice inside a day row: a ccusage model breakdown or a
 *  local transcript aggregate share the same fields. */
export interface UsageModelUsage {
    period?: string | undefined;
    modelName: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    totalTokens?: number;
    totalCost?: number;
}

export interface UsageDayRow {
    period: string;
    row?: {
        totalTokens: number;
        totalCost: number | undefined;
        modelBreakdowns: UsageModelUsage[];
    } | undefined;
}

/**
 * Week reduction for one provider's day rows (oldest first, today last).
 * Cost comes back only when every measured day recorded one; a day without a
 * cost makes the week unknown rather than free.
 */
export function activityTotals(days: UsageDayRow[]): { today: UsageDayRow['row']; tokensToday: number; tokensWeek: number; costToday: number | undefined; costWeek: number | undefined } {
    const today = days[days.length - 1]?.row;
    const tokensToday = today?.totalTokens ?? 0;
    const tokensWeek = days.reduce((sum, day) => sum + (day.row?.totalTokens ?? 0), 0);
    const costToday = today?.totalCost;
    const costWeekKnown = days.every(({ row }) => row === undefined || Number.isFinite(row.totalCost));
    const costWeek = costWeekKnown ? days.reduce((sum, day) => sum + (day.row?.totalCost ?? 0), 0) : undefined;
    return { today, tokensToday, tokensWeek, costToday, costWeek };
}

/** The bare model id behind a recorded name ("zai/glm-x:high" -> "glm-x"). */
function bareModel(name: unknown): string {
    const tail = String(name ?? '').split('/').pop() ?? '';
    return tail.split(':')[0] ?? '';
}

/** Model ids one provider owns, from the agent's own model registry. */
export function providerModelIds(modelsRaw: unknown, providerId: string): Set<string> {
    // Custom-provider config nests under `providers`; the model store keys
    // providers at the top level. Either may declare the same provider.
    const models = (modelsRaw as { providers?: Record<string, { models?: unknown }> } | undefined)?.providers?.[providerId]?.models
        ?? (modelsRaw as Record<string, { models?: unknown }> | undefined)?.[providerId]?.models;
    return new Set((Array.isArray(models) ? models : []).flatMap((model): string[] => {
        const id = typeof (model as { id?: unknown } | null)?.id === 'string' ? (model as { id: string }).id.trim() : '';
        return id !== '' && id.length <= 64 ? [id] : [];
    }));
}

/** The host's own line when muxr has no plan integration for the provider at
 *  all. A surface that owns a localized empty state shows that instead, so it
 *  is named here rather than spelled out at each reader. */
export const NOT_CONNECTED_MESSAGE = 'Plan limits aren\u2019t connected in muxr';

/** The tightest window decides the verdict: highest share used; on ties the
 *  first published window wins. Every surface that heads a payload with one
 *  window reads this, so none of them can pick a different one. */
export function tightestWindow<T extends { percentUsed: number }>(vms: readonly T[]): T | undefined {
    return vms.reduce<T | undefined>((worst, vm) => (worst === undefined || vm.percentUsed > worst.percentUsed ? vm : worst), undefined);
}

// Verdict boundaries in percent used, and how far over the elapsed pace a
// window must sit to read as ahead. ponytail: constants live beside the
// transforms; tune after a week of real numbers, the design's own advice.
const VERDICT_LOW = 90;
const VERDICT_WATCH = 75;
const AHEAD_MARGIN = 20;

/** Duration until a reset, spelled out ("16d 23h", "4h 11m"). */
function resetIn(resetEpochSec: number | undefined, nowMs: number): string {
    if (!Number.isFinite(resetEpochSec)) return '';
    let minutes = Math.round((resetEpochSec! * 1000 - nowMs) / 60_000);
    if (minutes < 1) return '';
    const days = Math.floor(minutes / 1440);
    minutes -= days * 1440;
    const hours = Math.floor(minutes / 60);
    const mins = minutes - hours * 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

/** Published length as a short suffix ("5h", "7d"). */
function windowName(minutes: number | undefined): string {
    if (!Number.isFinite(minutes) || (minutes ?? 0) <= 0) return '';
    if (minutes! % 1440 === 0) return `${minutes! / 1440}d`;
    if (minutes! % 60 === 0) return `${minutes! / 60}h`;
    return `${minutes!}m`;
}

/** The elapsed anchor and the pace verdict require a usable length and reset. */
function windowElapsed(used: number, minutes: number | undefined, reset: number | undefined, nowMs: number, clock: string): number | undefined {
    if (used === 0 || clock === '' || !Number.isFinite(minutes) || !Number.isFinite(reset) || resetIn(reset, nowMs) === '') return undefined;
    return Math.min(1, Math.max(0, 1 - (reset! * 1000 - nowMs) / (minutes! * 60_000)));
}

/** Limited beats share (90 -> low, 75 -> watch), then pace (20 points over
 *  elapsed -> ahead); otherwise a task can go ahead. */
function limitsVerdict(used: number, elapsed: number | undefined, limited: boolean): UsageLimitsPayload['verdict'] {
    if (limited || used >= 100) return 'limited';
    if (used >= VERDICT_LOW) return 'low';
    if (used >= VERDICT_WATCH) return 'watch';
    if (elapsed !== undefined && used - elapsed * 100 >= AHEAD_MARGIN) return 'ahead';
    return 'go';
}

/**
 * The rendering payload for the limits card, built from the same view models
 * every other surface reads.
 */
export function limitsPayload(vms: UsageWindowVM[], { plan, message, nowMs = Date.now() }: { plan?: string; message?: string; nowMs?: number } = {}): UsageLimitsPayload {
    if (!Array.isArray(vms) || vms.length === 0) {
        return { verdict: 'unknown', windows: [], ...(message === undefined ? {} : { message }) };
    }
    const windows: UsageLimitsWindow[] = vms.map((vm) => {
        const resetsIn = vm.resetClock === '' ? '' : resetIn(vm.resetEpochSec, nowMs);
        const elapsed = windowElapsed(vm.percentUsed, vm.windowMinutes, vm.resetEpochSec, nowMs, vm.resetClock);
        const name = windowName(vm.windowMinutes);
        return {
            label: vm.label,
            ...(name === '' ? {} : { window: name }),
            used: vm.percentUsed,
            pace: vm.pace.verdict,
            ...(resetsIn === '' ? {} : { resetsIn }),
            ...(elapsed === undefined || !Number.isFinite(elapsed) ? {} : { elapsed }),
        };
    });
    const tightest = tightestWindow(vms)!;
    const limited = vms.some((vm) => vm.limited || vm.percentUsed >= 100);
    const verdict = limitsVerdict(tightest.percentUsed, windows[vms.indexOf(tightest)]?.elapsed, limited);
    return {
        verdict,
        ...(plan === undefined ? {} : { plan }),
        ...(message === undefined ? {} : { message }),
        windows,
    };
}

/**
 * One provider's slice of another agent's measured local records: the day
 * rows whose models belong to it. Plan providers are priced by the plan, not
 * the token, so their slice never claims a dollar figure.
 */
export function localActivityForModels(report: { rows?: UsageModelUsage[]; latest?: number } | undefined, modelIds: Set<string>, periods: string[]): { days: UsageDayRow[]; latest?: number } | undefined {
    if (!Array.isArray(report?.rows) || modelIds.size === 0) return undefined;
    const days: UsageDayRow[] = periods.map((period) => ({ period, row: undefined }));
    let matched = false;
    for (const aggregate of report!.rows!) {
        if (!modelIds.has(bareModel(aggregate.modelName))) continue;
        matched = true;
        if (!Number.isSafeInteger(aggregate.totalTokens) || (aggregate.totalTokens ?? 0) < 0) continue;
        const day = days.find((candidate) => candidate.period === aggregate.period);
        if (!day) continue;
        day.row ??= { totalTokens: 0, totalCost: 0, modelBreakdowns: [] };
        day.row.totalTokens += aggregate.totalTokens ?? 0;
        day.row.totalCost = undefined;
        day.row.modelBreakdowns.push(aggregate);
    }
    if (!matched) return undefined;
    return { days, ...(report!.latest === undefined ? {} : { latest: report!.latest }) };
}
