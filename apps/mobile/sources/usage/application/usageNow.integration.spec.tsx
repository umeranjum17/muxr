import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import type { UsageNow } from '@muxr/contract';

/**
 * The Home card's whole read path, end to end against a scripted host.
 *
 * It exists because the card shipped frozen: it read usage.now exactly once per
 * mount, and the host's `collecting` answer -- which means "my cache was cold,
 * ask again, the collection is still running" -- became the card's permanent
 * state. Opening the Usage screen warmed the host and the card still said
 * Collecting usage, for as long as the app stayed open.
 *
 * So this drives what was wrong and what replaced it: a cold answer is followed
 * up rather than kept, a host that never finishes is reported instead of waited
 * on forever, figures already on screen are never taken away to refresh them,
 * and nothing is read for a card nobody is looking at.
 */

const request = vi.fn();
const appState = { currentState: 'active' as string, listeners: new Set<(next: string) => void>() };

vi.mock('@/catalog/sync', () => ({ sync: { request } }));
vi.mock('expo-router', async () => {
    const react = await import('react');
    // The real one runs its effect while the screen is focused; the probe is
    // always focused, so an ordinary effect is the same contract here.
    return { useFocusEffect: (callback: () => void | (() => void)) => react.useEffect(callback, [callback]) };
});
vi.mock('react-native', () => ({
    AppState: {
        get currentState() { return appState.currentState; },
        addEventListener: (_event: string, listener: (next: string) => void) => {
            appState.listeners.add(listener);
            return { remove: () => appState.listeners.delete(listener) };
        },
    },
}));

const { useUsageNow } = await import('./useUsageNow');

const FRESH_MS = 15 * 60_000;
const VITALS = { memoryUsed: 8, memoryTotal: 16, load1: 1.2, uptimeSeconds: 90_000 };
/** What the host sends while its usage cache is cold: the figures it already
 *  measured, and the flag that says the plan half is still being collected. */
const COLLECTING: UsageNow = { limits: { verdict: 'unknown', windows: [] }, collecting: true, vitals: VITALS };
/** What it sends once that collection lands. */
const collected = (ageSeconds?: number): UsageNow => ({
    limits: { verdict: 'limited', windows: [{ label: 'Rolling', window: '5h', used: 100 }] },
    connected: [{ id: 'opencode', label: 'OpenCode', windows: [{ label: 'Rolling', window: '5h', used: 100 }] }],
    ...(ageSeconds === undefined ? {} : { ageSeconds }),
    vitals: VITALS,
});

function mount() {
    const seen: ReturnType<typeof useUsageNow>[] = [];
    function Probe() {
        const read = useUsageNow();
        seen.push(read);
        return null;
    }
    TestRenderer.act(() => { TestRenderer.create(<Probe />); });
    return { seen, latest: () => seen[seen.length - 1]! };
}

/** Let the pending usage.now settle and any timer it armed come due. */
async function tick(ms = 0) {
    await TestRenderer.act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
    vi.useFakeTimers();
    request.mockReset();
    appState.currentState = 'active';
    appState.listeners.clear();
});
afterEach(() => { vi.useRealTimers(); });

describe('the Home card read path', () => {
    it('follows a cold answer through to collected figures and then keeps itself current', async () => {
        request.mockResolvedValueOnce(COLLECTING).mockResolvedValue(collected());
        const card = mount();

        await tick();
        // A cold answer is shown -- the vitals in it are measured and must not
        // be withheld -- but it is not the end of the read.
        expect(card.latest().value?.collecting).toBe(true);
        expect(card.latest().value?.vitals).toEqual(VITALS);
        expect(card.latest().failed).toBe(false);
        expect(card.latest().refreshing).toBe(true);
        expect(request).toHaveBeenCalledTimes(1);

        // Nobody touches the card. It asks again on its own, and applies the
        // answer that finally carries the plan windows.
        await tick(6_000);
        expect(request).toHaveBeenCalledTimes(2);
        expect(card.latest().value?.collecting).toBeUndefined();
        expect(card.latest().value?.limits.windows).toHaveLength(1);
        expect(card.latest().refreshing).toBe(false);

        // Settled: no further follow-up, because there is nothing left to wait for.
        await tick(60_000);
        expect(request).toHaveBeenCalledTimes(2);

        // It keeps itself current on the slow cadence rather than in a loop,
        // and asks the cheap cache-respecting question while the figures on
        // screen are still inside their window.
        await tick(FRESH_MS);
        expect(request).toHaveBeenCalledTimes(3);
        expect(request).toHaveBeenLastCalledWith('usage.now', {}, expect.any(Number));
    });

    it('re-collects rather than be served the same cached figures once they age past the window', async () => {
        // The host's usage cache answers with any same-day payload, so figures
        // a reader can see are old would otherwise never become current.
        request.mockResolvedValue(collected(FRESH_MS / 1_000 + 60));
        mount();

        await tick();
        expect(request).toHaveBeenLastCalledWith('usage.now', {}, expect.any(Number));

        await tick(FRESH_MS);
        expect(request).toHaveBeenLastCalledWith('usage.now', { refresh: true }, expect.any(Number));
    });

    it('never takes figures off the screen to refresh them, and says plainly when it could not', async () => {
        request.mockResolvedValueOnce(collected()).mockResolvedValueOnce(COLLECTING).mockRejectedValue(new Error('host unreachable'));
        const card = mount();
        await tick();
        const figures = card.latest().value;
        expect(figures?.limits.windows).toHaveLength(1);

        // A forced refresh that comes back cold leaves the collected figures
        // exactly where they were, and shows that it is still working.
        TestRenderer.act(() => { card.latest().refresh(); });
        await tick();
        expect(request).toHaveBeenLastCalledWith('usage.now', { refresh: true }, expect.any(Number));
        expect(card.latest().value).toBe(figures);
        expect(card.latest().refreshing).toBe(true);

        // And a failed one keeps them too, while saying so.
        await tick(6_000);
        expect(card.latest().value).toBe(figures);
        expect(card.latest().failed).toBe(true);
        expect(card.latest().refreshing).toBe(false);
    });

    it('stops claiming to collect when the host never finishes, and does not keep asking', async () => {
        request.mockResolvedValue(COLLECTING);
        const card = mount();

        await tick();
        for (let follow = 0; follow < 5; follow += 1) await tick(6_000);

        // Six honest attempts, then it says so rather than collecting forever.
        expect(request).toHaveBeenCalledTimes(6);
        expect(card.latest().failed).toBe(true);
        // The measured figures it did receive stay on screen behind that word.
        expect(card.latest().value?.vitals).toEqual(VITALS);

        const settled = request.mock.calls.length;
        await tick(60_000);
        expect(request).toHaveBeenCalledTimes(settled);
    });

    it('does not read for a card nobody is looking at', async () => {
        request.mockResolvedValue(collected());
        mount();
        await tick();
        expect(request).toHaveBeenCalledTimes(1);

        TestRenderer.act(() => { appState.currentState = 'background'; appState.listeners.forEach((listener) => listener('background')); });
        await tick(3 * FRESH_MS);
        expect(request).toHaveBeenCalledTimes(1);

        // Coming back is its own moment: the figures aged for the whole time away.
        await TestRenderer.act(async () => {
            appState.currentState = 'active';
            appState.listeners.forEach((listener) => listener('active'));
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(request).toHaveBeenCalledTimes(2);
    });
});
