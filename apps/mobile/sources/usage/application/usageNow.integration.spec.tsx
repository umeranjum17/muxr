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
 * and the refresh control a person presses is the one these taps go through.
 */

const request = vi.fn();
const appState = { currentState: 'active' as string, listeners: new Set<(next: string) => void>() };
const theme = {
    colors: {
        text: '#fff',
        textSecondary: '#999',
        textDestructive: '#f55',
        surfaceHigh: '#222',
        surface: '#111',
        accent: '#0af',
        divider: '#333',
        surfacePressed: '#333',
        textLink: '#0af',
        header: { tint: '#fff' },
    },
};

vi.mock('@/catalog/sync', () => ({ sync: { request } }));
vi.mock('expo-router', async () => {
    const react = await import('react');
    // The real one runs its effect while the screen is focused; the probe is
    // always focused, so an ordinary effect is the same contract here.
    return {
        useFocusEffect: (callback: () => void | (() => void)) => react.useEffect(callback, [callback]),
        useRouter: () => ({ push: () => undefined }),
    };
});
vi.mock('react-native', () => ({
    AppState: {
        get currentState() { return appState.currentState; },
        addEventListener: (_event: string, listener: (next: string) => void) => {
            appState.listeners.add(listener);
            return { remove: () => appState.listeners.delete(listener) };
        },
    },
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@/components/ui', () => ({
    cardStyle: () => ({}),
    Meter: 'Meter',
    SectionLabel: 'SectionLabel',
    withAlpha: () => '#000',
}));
vi.mock('@/components/AgentGlyph', () => ({ AgentGlyph: 'AgentGlyph' }));
vi.mock('@/constants/Typography', () => ({ Typography: { mono: () => ({}), default: () => ({}) } }));
vi.mock('@/plugins', () => ({ toneColor: () => '#000' }));
vi.mock('@/plugins/ui', () => ({ VERDICT_KEYS: { limited: 'plugins.limits.limited' }, verdictTone: () => undefined }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

const { useUsageNow } = await import('./useUsageNow');
const { RightNowCard } = await import('../presentation/RightNowCard');

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

function renderCard() {
    let renderer: any;
    TestRenderer.act(() => { renderer = TestRenderer.create(<RightNowCard />); });
    return renderer!;
}

/** Press the card's own refresh control, the way a person reaches it. */
function pressRefresh(renderer: any, label = 'plugins.rightNow.refreshNow') {
    const control = renderer.root.findAll((node: any) => node.props?.accessibilityRole === 'button'
        && node.props?.disabled !== true
        && typeof node.props?.accessibilityLabel === 'string'
        && node.props.accessibilityLabel.endsWith(label))[0];
    if (control === undefined) throw new Error('the card has no refresh control to press');
    TestRenderer.act(() => { control.props.onPress(); });
}

const screenText = (renderer: any): string => renderer.root.findAllByType('Text')
    .map((node: any) => (typeof node.props.children === 'string' ? node.props.children : ''))
    .join(' ');

/** Press any control by its label, for the card states that offer one. */
function press(renderer: any, label: string) {
    const control = renderer.root.findAll((node: any) => node.props?.accessibilityLabel === label && node.props?.onPress !== undefined)[0];
    if (control === undefined) throw new Error(`no control labelled ${label}`);
    TestRenderer.act(() => { control.props.onPress(); });
}

/** Every read that asked the host to collect past its cache. */
const forcedReads = () => request.mock.calls.filter((call) => (call[1] as { refresh?: boolean } | undefined)?.refresh === true);

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

    it('accepts a genuinely newer payload whose age is larger than the one it replaces', async () => {
        // The replaced figures were painted at age 3s; the collection the tap
        // started answers six seconds later, so its capture is newer even
        // though its age is larger. Comparing raw ages alone would discard it
        // and exhaust the read into a false failure.
        request.mockResolvedValueOnce(collected(3)).mockResolvedValueOnce(COLLECTING).mockResolvedValue(collected(6));
        const card = mount();
        await tick();

        TestRenderer.act(() => { card.latest().refresh(); });
        await tick();
        expect(card.latest().refreshing).toBe(true);

        await tick(6_000);
        expect(card.latest().value?.ageSeconds).toBe(6);
        expect(card.latest().refreshing).toBe(false);

        const settled = request.mock.calls.length;
        await tick(60_000);
        expect(request).toHaveBeenCalledTimes(settled);
    });

    it('keeps waiting when a follow-up is answered by the same capture', async () => {
        // A replay carries the replaced capture, but both instants are rebuilt
        // from whole-second ages, so its rounding can place it up to a second
        // later. That is still not the collection finishing, so the read asks
        // again -- and still accepts the collection once it lands.
        request.mockResolvedValueOnce(collected(1_200)).mockResolvedValueOnce(COLLECTING).mockResolvedValueOnce(collected(1_205)).mockResolvedValue(collected(1));
        const card = mount();
        await tick();

        TestRenderer.act(() => { card.latest().refresh(); });
        await tick();
        expect(card.latest().refreshing).toBe(true);

        await tick(6_000);
        expect(card.latest().value?.ageSeconds).toBe(1_200);
        expect(card.latest().refreshing).toBe(true);

        await tick(6_000);
        expect(card.latest().value?.ageSeconds).toBe(1);
        expect(card.latest().refreshing).toBe(false);
    });

    it('does not restart a collecting burst from a cycle event, but a later cycle starts whole', async () => {
        request.mockResolvedValue(COLLECTING);
        const card = mount();
        await tick();

        // A foreground return lands mid-burst and must not hand it a fresh
        // budget: the six attempts stay six.
        TestRenderer.act(() => { appState.currentState = 'active'; appState.listeners.forEach((listener) => listener('active')); });
        await tick();
        for (let follow = 0; follow < 4; follow += 1) await tick(6_000);
        expect(request).toHaveBeenCalledTimes(6);
        expect(card.latest().failed).toBe(true);

        // The burst has settled: the next cadence cycle gets its own budget.
        await tick(FRESH_MS);
        for (let follow = 0; follow < 5; follow += 1) await tick(6_000);
        expect(request).toHaveBeenCalledTimes(12);
    });

    it('does not spend the forced budget on a cycle that could only join a read', async () => {
        let release: (value: UsageNow) => void = () => undefined;
        request.mockResolvedValueOnce(collected(FRESH_MS / 1_000 + 60))
            .mockResolvedValueOnce(COLLECTING)
            .mockImplementationOnce(() => new Promise<UsageNow>((resolve) => { release = resolve; }))
            .mockResolvedValue(collected());
        const card = mount();
        await tick();

        // One forced read starts, and its burst leaves a follow-up in flight...
        TestRenderer.act(() => { appState.currentState = 'active'; appState.listeners.forEach((listener) => listener('active')); });
        await tick();
        await tick(6_000);

        // ...when a cycle lands, more than ten seconds after the read that
        // really ran. It can only join, so it must not claim the budget.
        await tick(5_000);
        TestRenderer.act(() => { appState.listeners.forEach((listener) => listener('active')); });
        await TestRenderer.act(async () => { release(COLLECTING); });

        // A tap now is more than ten seconds after that read, so it is honoured
        // rather than told to wait for a read that never ran.
        await tick(1_000);
        TestRenderer.act(() => { card.latest().refresh(); });
        await tick();
        expect(forcedReads()).toHaveLength(2);
    });

    it('says a throttled tap is throttled when a person presses the card control', async () => {
        request.mockResolvedValue(collected());
        const card = renderCard();
        await tick();

        // The first tap is honoured, past the host's cache.
        pressRefresh(card);
        await tick();
        expect(forcedReads()).toHaveLength(1);
        const read = request.mock.calls.length;

        // The next tap lands inside the window the first claimed: it is told
        // when it can run, and issues no cache-bypassing read of its own.
        pressRefresh(card);
        await tick();
        expect(screenText(card)).toContain('plugins.rightNow.refreshThrottled');
        expect(request.mock.calls.length).toBe(read);
        expect(forcedReads()).toHaveLength(1);
    });

    it('lets a tap on the card control re-collect straight after a failure', async () => {
        request.mockResolvedValueOnce(collected(FRESH_MS / 1_000 + 60)).mockRejectedValueOnce(new Error('host unreachable')).mockResolvedValue(collected());
        const card = renderCard();
        await tick();

        pressRefresh(card);
        await tick(1_000);
        expect(screenText(card)).toContain('plugins.rightNow.refreshFailed');

        // Someone already looking at an error is being told to try again: that
        // tap bypasses the cache, even one second after the last read.
        pressRefresh(card);
        await tick();
        expect(forcedReads()).toHaveLength(2);
    });

    it('runs a failed tap past the cache once the read already in flight settles', async () => {
        request.mockRejectedValueOnce(new Error('host unreachable')).mockResolvedValue(collected());
        const card = renderCard();
        await tick();
        // The first read failed with nothing to show, so the card offers a retry.
        expect(screenText(card)).toContain('plugins.rightNow.unavailable');

        // A background read starts behind that retry, and the tap lands while
        // it is still in flight.
        TestRenderer.act(() => { appState.listeners.forEach((listener) => listener('active')); });
        press(card, 'plugins.rightNow.unavailable');
        expect(forcedReads()).toHaveLength(0);

        // It is not answered by that read: it runs past the cache the moment
        // the read settles.
        await tick();
        expect(forcedReads()).toHaveLength(1);
        expect(request).toHaveBeenLastCalledWith('usage.now', { refresh: true }, expect.any(Number));
    });
});
