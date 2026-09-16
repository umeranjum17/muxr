/**
 * The usage view model. Every provider's quota windows and every measured
 * activity figure map into these plain-data shapes, and every rendering
 * surface reads only from them -- no surface ever sees a provider's raw
 * payload, so no provider can put its own dialect on the screen.
 *
 * Dialects end here. Sources report "how much used" (Claude, Z.ai, Go) or
 * "how much left" (quota-style percentRemaining feeds); normalizeWindow
 * accepts either one dialect as input and derives the other, so the pair can
 * never disagree. Reset clocks and pace verdicts come from rateLimits.mjs --
 * the same module the rate-limit block renders from -- never re-decided here.
 */

import { paceVerdict, resetClock, WINDOW_MINUTES } from './rateLimits.mjs';

const clampPct = (value) => Math.max(0, Math.min(100, value));

/**
 * One uniform window. `used` and `remaining` are the two input dialects;
 * supply exactly one, the other comes back derived. Plain data throughout,
 * so declarative surfaces can bind it directly.
 */
export function normalizeWindow({ provider, windowKind, label, used, remaining, windowMinutes, resetEpochSec, nowMs, limited = false }) {
    const hasUsed = Number.isFinite(used);
    const hasRemaining = Number.isFinite(remaining);
    const percentUsed = clampPct(hasUsed ? used : 100 - remaining);
    if (!hasUsed && !hasRemaining) return undefined;
    return {
        provider,
        windowKind,
        label,
        percentUsed,
        // Derived, never independently sourced: one input dialect in, the
        // other computed, so a source cannot publish a contradictory pair.
        percentRemaining: 100 - percentUsed,
        windowMinutes: Number.isFinite(windowMinutes) && windowMinutes > 0 ? windowMinutes : undefined,
        resetEpochSec: Number.isFinite(resetEpochSec) ? resetEpochSec : undefined,
        resetClock: resetClock(resetEpochSec, nowMs),
        pace: paceVerdict({ used: percentUsed, windowMinutes, resetEpochSec, nowMs, limited }),
    };
}

/** Chart row for a window: the exact shape the rate-limit block renders.
 *  Tone and detail render the view model's own pace verdict -- decided once
 *  by rateLimits.mjs at collection time -- so a row can never disagree with
 *  its window. */
export function windowRow(vm) {
    return {
        label: vm.label,
        value: vm.percentRemaining,
        valueLabel: `${Math.round(vm.percentRemaining)}% left`,
        tone: vm.pace.tone,
        // Fits the bar-chart detail slot (≤24 bytes) the manifest binds.
        detail: vm.resetClock === '' ? vm.pace.verdict : `${vm.resetClock} · ${vm.pace.verdict}`,
    };
}

// --- Per-provider transforms: raw payload in, view models out. ---

const CLAUDE_WINDOWS = [['five_hour', 'session', '5-hour limit'], ['seven_day', 'weekly', '7-day limit']];

/** Claude oauth/usage payload: `rate_limits.five_hour.utilization` is percent used. */
export function claudeWindows(raw, { provider = 'claude', nowMs }) {
    const source = raw?.rate_limits ?? raw;
    return CLAUDE_WINDOWS.flatMap(([id, kind, label]) => {
        const window = source?.[id];
        const used = window?.utilization ?? window?.used_percentage;
        const resetEpochSec = typeof window?.resets_at === 'number' ? window.resets_at : Date.parse(window?.resets_at) / 1000;
        return [normalizeWindow({
            provider, windowKind: kind, label, used, windowMinutes: WINDOW_MINUTES[id],
            resetEpochSec, nowMs,
        })].filter(Boolean);
    });
}

/** Z.ai monitor payload: `limits[].percentage` is percent used. */
export function zaiWindows(limits, { provider = 'zai', nowMs }) {
    // Monitor buckets arrive as unit/number pairs; unknown pairs are skipped
    // rather than guessed at, so a schema change degrades to "unavailable".
    const windows = new Map([
        ['3:5', { kind: 'session', label: '5-hour limit', windowMinutes: WINDOW_MINUTES.five_hour }],
        ['6:1', { kind: 'weekly', label: 'Weekly limit', windowMinutes: WINDOW_MINUTES.seven_day }],
    ]);
    return (Array.isArray(limits) ? limits : []).flatMap((limit) => {
        const window = windows.get(`${limit?.unit}:${limit?.number}`);
        if (window === undefined) return [];
        return [normalizeWindow({
            provider, windowKind: window.kind, label: window.label, windowMinutes: window.windowMinutes,
            used: limit?.percentage, resetEpochSec: Number(limit?.nextResetTime) / 1000, nowMs,
        })].filter(Boolean);
    });
}

/** OpenCode Go payload: `usage[key].percent` is percent used, status marks rate limiting. */
export function goWindows(usage, { provider = 'opencode', nowMs }) {
    // Rolling is documented as five hours and the weekly reset as Monday 00:00
    // UTC; the monthly anchor is the subscription date, so it publishes no
    // length and never claims a pace projection.
    const lengths = { rolling: WINDOW_MINUTES.five_hour, weekly: WINDOW_MINUTES.weekly, monthly: undefined };
    return [['rolling', 'Rolling'], ['weekly', 'Weekly'], ['monthly', 'Monthly']].flatMap(([key, label]) => {
        const window = usage?.[key];
        if (!Number.isFinite(window?.percent) || window.percent < 0 || !['ok', 'rate-limited'].includes(window.status)) return [];
        return [normalizeWindow({
            provider, windowKind: key, label, used: window.percent,
            windowMinutes: lengths[key], resetEpochSec: Date.parse(window.resetsAt) / 1000,
            nowMs, limited: window.status === 'rate-limited',
        })].filter(Boolean);
    });
}

/** Codex app-server payload: windows carry usedPercent plus their own durations. */
export function codexWindows(limits, { provider = 'codex', nowMs }) {
    const kindForMinutes = (minutes) => {
        if (minutes <= 1_440) return 'session';
        return minutes <= 10_080 ? 'weekly' : 'monthly';
    };
    return limits.flatMap((limit) => ['primary', 'secondary'].flatMap((key) => {
        const window = limit?.[key];
        if (!Number.isFinite(window?.usedPercent)) return [];
        const rawMinutes = window.windowDurationMins;
        const windowMinutes = Number.isFinite(rawMinutes) && rawMinutes > 0 ? rawMinutes : undefined;
        return [normalizeWindow({
            provider, windowKind: windowMinutes === undefined ? 'session' : kindForMinutes(windowMinutes),
            label: `${limit.limitName ?? limit.limitId ?? 'Codex'} · ${windowMinutes === undefined ? key : `${windowMinutes / 60}h`}`,
            used: window.usedPercent, windowMinutes, resetEpochSec: window.resetsAt, nowMs,
        })].filter(Boolean);
    }));
}

// --- Measured activity: local session records in, totals out. ---

/**
 * Week reduction for one provider's day rows (oldest first, today last).
 * Cost comes back only when every measured day recorded one; a day without a
 * cost makes the week unknown rather than free.
 */
export function activityTotals(days) {
    const today = days[days.length - 1]?.row;
    const tokensToday = today?.totalTokens ?? 0;
    const tokensWeek = days.reduce((sum, day) => sum + (day.row?.totalTokens ?? 0), 0);
    const costToday = today?.totalCost;
    const costWeekKnown = days.every(({ row }) => row === undefined || Number.isFinite(row.totalCost));
    const costWeek = costWeekKnown ? days.reduce((sum, day) => sum + (day.row?.totalCost ?? 0), 0) : undefined;
    return { today, tokensToday, tokensWeek, costToday, costWeek };
}

/** The bare model id behind a recorded name ("zai/glm-x:high" -> "glm-x"). */
function bareModel(name) {
    return String(name ?? '').split('/').pop().split(':')[0];
}

/** Model ids one provider owns, from the agent's own model registry. */
export function providerModelIds(modelsRaw, providerId) {
    // Custom-provider config nests under `providers`; the model store keys
    // providers at the top level. Either may declare the same provider.
    const models = modelsRaw?.providers?.[providerId]?.models ?? modelsRaw?.[providerId]?.models;
    return new Set((Array.isArray(models) ? models : []).flatMap((model) => {
        const id = typeof model?.id === 'string' ? model.id.trim() : '';
        return id !== '' && id.length <= 64 ? [id] : [];
    }));
}

/** The tightest window decides the verdict: highest share used; on ties the
 *  first published window wins. */
function tightestWindow(vms) {
    return vms.reduce((worst, vm) => (worst === undefined || vm.percentUsed > worst.percentUsed ? vm : worst), undefined);
}

// Verdict boundaries in percent used, and how far over the elapsed pace a
// window must sit to read as ahead. ponytail: constants live beside the
// transforms; tune after a week of real numbers, the design's own advice.
const VERDICT_LOW = 90;
const VERDICT_WATCH = 75;
const AHEAD_MARGIN = 20;

/** Duration until a reset, spelled out ("16d 23h", "4h 11m"). */
function resetIn(resetEpochSec, nowMs) {
    if (!Number.isFinite(resetEpochSec)) return '';
    let minutes = Math.round((resetEpochSec * 1000 - nowMs) / 60_000);
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
function windowName(minutes) {
    if (!Number.isFinite(minutes) || minutes <= 0) return '';
    if (minutes % 1440 === 0) return `${minutes / 1440}d`;
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
}

/**
 * The rendering payload for the declarative `limits` node, built from the
 * same view models every other surface reads. Verdict rules: limited beats
 * everything, then the tightest window's share (90 -> low, 75 -> watch), then
 * pace (20 points over the elapsed fraction -> ahead), otherwise go.
 */
export function limitsPayload(vms, { plan, message, nowMs = Date.now() }) {
    if (!Array.isArray(vms) || vms.length === 0) {
        return { verdict: 'unknown', windows: [], ...(message === undefined ? {} : { message }) };
    }
    const windows = vms.map((vm) => {
        const resetsIn = resetIn(vm.resetEpochSec, nowMs);
        const elapsed = vm.percentUsed > 0 && Number.isFinite(vm.windowMinutes) && Number.isFinite(vm.resetEpochSec)
            ? Math.min(1, Math.max(0, 1 - (vm.resetEpochSec * 1000 - nowMs) / (vm.windowMinutes * 60_000)))
            : undefined;
        return {
            label: vm.label,
            ...(windowName(vm.windowMinutes) === '' ? {} : { window: windowName(vm.windowMinutes) }),
            used: Math.round(vm.percentUsed),
            ...(resetsIn === '' ? {} : { resetsIn }),
            ...(elapsed === undefined || !Number.isFinite(elapsed) ? {} : { elapsed }),
        };
    });
    const tightest = tightestWindow(vms);
    const limited = vms.some((vm) => vm.pace.verdict === 'limited' || vm.percentUsed >= 100);
    const verdict = limited ? 'limited'
        : tightest.percentUsed >= VERDICT_LOW ? 'low'
        : tightest.percentUsed >= VERDICT_WATCH ? 'watch'
        : (() => {
            const elapsed = windows[vms.indexOf(tightest)]?.elapsed;
            return elapsed !== undefined && tightest.percentUsed - elapsed * 100 >= AHEAD_MARGIN ? 'ahead' : 'go';
        })();
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
export function localActivityForModels(report, modelIds, periods) {
    if (!Array.isArray(report?.rows) || modelIds.size === 0) return undefined;
    const days = periods.map((period) => ({ period, row: undefined }));
    let matched = false;
    for (const aggregate of report.rows) {
        if (!modelIds.has(bareModel(aggregate.modelName))) continue;
        matched = true;
        if (!Number.isSafeInteger(aggregate.totalTokens) || aggregate.totalTokens < 0) continue;
        const day = days.find((candidate) => candidate.period === aggregate.period);
        if (!day) continue;
        day.row ??= { totalTokens: 0, totalCost: 0, modelBreakdowns: [] };
        day.row.totalTokens += aggregate.totalTokens;
        day.row.totalCost = undefined;
        day.row.modelBreakdowns.push(aggregate);
    }
    if (!matched) return undefined;
    return { days, latest: report.latest };
}
