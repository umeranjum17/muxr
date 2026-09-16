import { describe, expect, it } from 'vitest';
import {
    activityTotals, bindingWindow, claudeWindows, codexWindows, goWindows, localActivityForModels,
    normalizeWindow, providerModelIds, windowHeadline, windowRow, zaiWindows,
} from './usageWindows.mjs';

process.env.TZ = 'UTC';
/** A Saturday noon: far enough from midnight that clocks stay on one day. */
const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);
const resetIn = (minutes) => (NOW + minutes * 60_000) / 1000;

/** One raw payload per provider, each reporting a window 40% used. */
const RAW = {
    claude: { rate_limits: { five_hour: { used_percentage: 40, resets_at: resetIn(150) } } },
    zai: [{ unit: 3, number: 5, percentage: 40, nextResetTime: (resetIn(150)) * 1000 }],
    go: { rolling: { status: 'ok', percent: 40, resetsAt: new Date(resetIn(150) * 1000).toISOString() } },
    codex: [{ limitName: 'Codex', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: resetIn(150) } }],
};

describe('one usage view model behind every provider dialect', () => {
    const groups = {
        claude: claudeWindows(RAW.claude, { nowMs: NOW }),
        zai: zaiWindows(RAW.zai, { nowMs: NOW }),
        go: goWindows(RAW.go, { nowMs: NOW }),
        codex: codexWindows(RAW.codex, { nowMs: NOW }),
    };

    it('maps every provider raw shape to the same view-model shape', () => {
        const shape = (vm) => Object.keys(vm).sort().join(',');
        const [first] = Object.values(groups).flat();
        for (const vm of Object.values(groups).flat()) {
            // Same shape, same derived pair, same clock; pace differs only by
            // what each provider publishes about its own window.
            expect(shape(vm)).toBe(shape(first));
            expect([vm.percentUsed, vm.percentRemaining, vm.resetClock]).toEqual([40, 60, '2:30 PM']);
        }
        expect(groups.claude[0].pace).toEqual({ verdict: 'on pace', tone: 'warning' });
        expect(groups.zai[0].pace).toEqual({ verdict: 'on pace', tone: 'warning' });
        expect(groups.codex[0].pace).toEqual({ verdict: 'on pace', tone: 'warning' });
        // Rolling's documented length is five hours, so it projects like the
        // session windows do.
        expect(groups.go[0].windowKind).toBe('rolling');
        expect(groups.go[0].windowMinutes).toBe(300);
        expect(groups.go[0].pace).toEqual({ verdict: 'on pace', tone: 'warning' });
        expect(groups.claude[0].windowKind).toBe('session');
        expect(groups.zai[0].provider).toBe('zai');
        expect(groups.codex[0].windowMinutes).toBe(300);
    });

    it('derives remaining from used and used from remaining, never trusting a pair', () => {
        const fromUsed = normalizeWindow({ provider: 'p', windowKind: 'session', label: 'L', used: 13, windowMinutes: 300, resetEpochSec: resetIn(250), nowMs: NOW });
        expect(fromUsed.percentRemaining).toBe(87);
        // The quota style feeds percentRemaining only; used comes back derived.
        const fromRemaining = normalizeWindow({ provider: 'p', windowKind: 'session', label: 'L', remaining: 87, windowMinutes: 300, resetEpochSec: resetIn(250), nowMs: NOW });
        expect(fromRemaining.percentUsed).toBe(13);
        expect({ ...fromUsed, provider: fromRemaining.provider, label: fromRemaining.label }).toEqual(fromRemaining);
        // No percentage at all: no window, rather than an invented one.
        expect(normalizeWindow({ provider: 'p', windowKind: 'session', label: 'L', nowMs: NOW })).toBeUndefined();
    });

    it('renders rows and headlines through the rate-limit block module', () => {
        const [vm] = groups.claude;
        const row = windowRow(vm);
        expect(row.valueLabel).toBe('60% left');
        expect(row.tone).toBe('warning');
        expect(row.detail).toBe('2:30 PM · on pace');
        expect(windowHeadline(vm)).toBe('60% left · on pace · 2:30 PM');
        // The binding window is the one closest to its limit.
        expect(bindingWindow([{ ...vm, percentRemaining: 50 }, { ...vm, percentRemaining: 61 }, vm]).percentRemaining).toBe(50);
    });

    it('reduces measured local records into provider slices without fabricated cost', () => {
        expect(providerModelIds({ providers: { zai: { models: [{ id: 'glm-x' }] } } }, 'zai')).toEqual(new Set(['glm-x']));
        expect(providerModelIds({ zai: { models: [{ id: 'glm-x' }, { id: 'glm-y' }] } }, 'zai')).toEqual(new Set(['glm-x', 'glm-y']));
        const report = {
            rows: [
                { period: '2026-09-05', modelName: 'glm-x', totalTokens: 700, totalCost: 0.5 },
                { period: '2026-09-05', modelName: 'zai/glm-y:high', totalTokens: 300 },
                { period: '2026-09-05', modelName: 'claude-opus-5', totalTokens: 9_000 },
            ],
            latest: NOW,
        };
        const slice = localActivityForModels(report, new Set(['glm-x', 'glm-y']), ['2026-09-04', '2026-09-05']);
        expect(slice.days[0].row).toBeUndefined();
        expect(slice.days[1].row.totalTokens).toBe(1000);
        // Plan tokens are priced by the plan: a recorded dollar never survives.
        expect(slice.days[1].row.totalCost).toBeUndefined();
        const totals = activityTotals(slice.days);
        expect(totals.tokensToday).toBe(1000);
        expect(totals.tokensWeek).toBe(1000);
        expect(totals.costToday).toBeUndefined();
        // A measured day with no activity cost nothing; a missing cost makes
        // the week unknown rather than free.
        const costed = activityTotals([
            { period: '2026-09-04', row: { totalTokens: 5, totalCost: 0.25, modelBreakdowns: [] } },
            { period: '2026-09-05', row: undefined },
        ]);
        expect(costed.tokensToday).toBe(0);
        expect(costed.costToday).toBeUndefined();
        expect(costed.costWeek).toBe(0.25);
    });
});
