import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import type { UsageNow, UsageReport } from '@muxr/contract';
import { FRESH_MS, noteAsked, rememberShown, shownUsage, withNow, withReport } from './freshnessWindow';

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
const hapticsSelection = vi.fn();
const connection = { machineId: 'machine-1' };
const appState = { currentState: 'active' as string, listeners: new Set<(next: string) => void>() };
let screenWidth = 393;
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
        status: { done: '#0a0', error: '#f55' },
        box: { warning: { text: '#fa0' } },
    },
};

vi.mock('@/catalog/sync', () => ({ sync: { request } }));
// Figures, windows and last-known readings are all per machine: a test is one
// machine, so nothing another test asked or held can reach it.
vi.mock('@/connection', () => ({ getCachedConnectionSettings: () => connection }));
vi.mock('expo-router', async () => {
    const react = await import('react');
    // The real one runs its effect while the screen is focused; the probe is
    // always focused, so an ordinary effect is the same contract here.
    return {
        useFocusEffect: (callback: () => void | (() => void)) => react.useEffect(callback, [callback]),
        useLocalSearchParams: () => ({}),
        useRouter: () => ({ push: () => undefined, back: () => undefined }),
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
    RefreshControl: 'RefreshControl',
    ScrollView: 'ScrollView',
    StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
    Text: 'Text',
    useWindowDimensions: () => ({ width: screenWidth, height: 852, scale: 3, fontScale: 1 }),
    View: 'View',
}));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@/components/haptics', () => ({ hapticsSelection }));
vi.mock('@/components/navigation/Header', async () => {
    const react = await import('react');
    return {
        Header: (props: { headerLeft?: () => React.ReactNode; headerRight?: () => React.ReactNode }) =>
            react.createElement(react.Fragment, null, props.headerLeft?.() ?? null, props.headerRight?.() ?? null),
    };
});
vi.mock('@/components/navigation/HeaderBackButton', () => ({ HeaderBackButton: 'HeaderBackButton' }));
vi.mock('@/components/ui', () => ({
    cardStyle: () => ({}),
    Meter: 'Meter',
    Notice: 'Notice',
    SectionLabel: 'SectionLabel',
    withAlpha: () => '#000',
}));
vi.mock('@/components/AgentGlyph', () => ({ AgentGlyph: 'AgentGlyph' }));
vi.mock('@/constants/Typography', () => ({ Typography: { mono: () => ({}), default: () => ({}) } }));
vi.mock('@/plugins', () => ({ toneColor: (_theme: unknown, tone?: string) => `tone:${tone}` }));
vi.mock('@/plugins/ui', () => ({
    ScreenChart: 'ScreenChart',
    ScreenLimits: 'ScreenLimits',
    VERDICT_KEYS: { limited: 'plugins.limits.limited' },
    verdictTone: () => undefined,
}));
// Keys stand in for words; a share keeps its figure, as every real string does,
// and a sentence keeps what it was given to say.
vi.mock('@/text', () => ({
    t: (key: string, params?: Record<string, unknown>) => (params === undefined ? key
        : params.percent !== undefined ? `${params.percent}% ${key}`
            : `${key}(${Object.values(params).join(' | ')})`),
}));

const { useUsageNow } = await import('./useUsageNow');
const { RightNowCard } = await import('../presentation/RightNowCard');
const { UsageScreen } = await import('../presentation/UsageScreen');

const VITALS = { memoryUsed: 8, memoryTotal: 16, load1: 1.2, uptimeSeconds: 90_000 };
/** What the host sends while its usage cache is cold: the figures it already
 *  measured, and the flag that says the plan half is still being collected. */
const COLLECTING: UsageNow = { limits: { verdict: 'unknown', windows: [] }, collecting: true, vitals: VITALS };
/** What it sends once that collection lands. */
const collected = (ageSeconds?: number, used = 100, capturedAt?: string): UsageNow => ({
    limits: { verdict: 'limited', windows: [{ label: 'Rolling', window: '5h', used }] },
    connected: [{ id: 'opencode', label: 'OpenCode', windows: [{ label: 'Rolling', window: '5h', used }] }],
    ...(ageSeconds === undefined ? {} : { ageSeconds }),
    ...(capturedAt === undefined ? {} : { capturedAt }),
    vitals: VITALS,
});
/** What the Usage screen reads: two tabs, no charts, and the host's own words
 *  on how old the payload is. `stale` is the host's coarse sixty-second flag,
 *  which no longer decides whether the phone collects. */
const report = (provider: string, ageSeconds: number): UsageReport => ({
    providers: [{ id: 'claude', label: 'Claude', glyph: 'claude' }, { id: 'opencode', label: 'OpenCode', glyph: 'opencode' }],
    provider,
    providerName: provider === 'opencode' ? 'OpenCode' : 'Anthropic Claude',
    todayTokens: '1',
    todayCost: '$0',
    modelSeries: [],
    weekTokens: '1',
    weekCost: '$0',
    weekSeries: [],
    capturedAt: new Date(Date.now() - ageSeconds * 1_000).toISOString(),
    ageSeconds,
    windowPeriods: [],
    windows: [],
    limits: { verdict: 'go', windows: [] },
    ...(ageSeconds > 60 ? { stale: true as const } : {}),
});

/** The figures a card read is showing, or undefined when it is showing its wait
 *  or its failure instead. */
const figuresOf = (read: ReturnType<typeof useUsageNow>) => (read.display.status === 'figures' ? read.display.figures : undefined);

/** The machine facts a card read is showing, whichever state it is in. */
const vitalsOf = (read: ReturnType<typeof useUsageNow>) => (read.display.status === 'figures' ? read.display.figures.vitals : read.display.vitals);

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

/** Everything a test renders, so a surface it left mounted cannot react to the
 *  next test's store write. */
const mounted: any[] = [];

function renderCard() {
    let renderer: any;
    TestRenderer.act(() => { renderer = TestRenderer.create(<RightNowCard />); });
    mounted.push(renderer!);
    return renderer!;
}

function renderScreen() {
    let renderer: any;
    TestRenderer.act(() => { renderer = TestRenderer.create(<UsageScreen />); });
    mounted.push(renderer!);
    return renderer!;
}

/** Every control that asks the host to collect now, wherever it renders. */
const refreshControls = (renderer: any) => renderer.root.findAll((node: any) => node.props?.accessibilityRole === 'button'
    && typeof node.props?.accessibilityLabel === 'string'
    && node.props.accessibilityLabel.endsWith('plugins.rightNow.refreshNow'));

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

let testEpoch = Date.now();
let machineCount = 0;
beforeEach(() => {
    vi.useFakeTimers();
    // The per-tab window outlives a screen and a test, so each one starts a day
    // on: a previous test's ask cannot close this one's window.
    testEpoch += 24 * 60 * 60_000;
    vi.setSystemTime(testEpoch);
    connection.machineId = `machine-${machineCount += 1}`;
    request.mockReset();
    hapticsSelection.mockClear();
    appState.currentState = 'active';
    appState.listeners.clear();
    screenWidth = 393;
});
afterEach(() => {
    for (const renderer of mounted.splice(0)) TestRenderer.act(() => { renderer.unmount(); });
    vi.useRealTimers();
});

describe('the Home card read path', () => {
    it('follows a cold answer through to collected figures and then keeps itself current', async () => {
        request.mockResolvedValueOnce(COLLECTING).mockResolvedValue(collected());
        const card = mount();

        await tick();
        // A cold answer is a wait, with the vitals it measured -- but it is not
        // the end of the read: the host is still collecting, so the card asks
        // again.
        expect(card.latest().display.status).toBe('waiting');
        expect(vitalsOf(card.latest())).toEqual(VITALS);
        expect(card.latest().failed).toBe(false);
        expect(card.latest().refreshing).toBe(true);
        expect(request).toHaveBeenCalledTimes(1);

        // Nobody touches the card. It asks again on its own, and applies the
        // answer that finally carries the plan windows.
        await tick(6_000);
        expect(request).toHaveBeenCalledTimes(2);
        expect(card.latest().display.status).toBe('figures');
        expect(figuresOf(card.latest())?.limits.windows).toHaveLength(1);
        expect(card.latest().refreshing).toBe(false);

        // Settled: no further follow-up, because there is nothing left to wait for.
        await tick(60_000);
        expect(request).toHaveBeenCalledTimes(2);

        // It keeps itself current on the slow cadence rather than in a loop:
        // the window measured from its own ask has opened, so the cycle
        // collects again rather than serving the same figures.
        await tick(FRESH_MS);
        expect(request).toHaveBeenCalledTimes(3);
        expect(request).toHaveBeenLastCalledWith('usage.now', { refresh: true }, expect.any(Number));
    });

    it('asks on the first view, and holds for a window measured from that ask rather than from the round trip', async () => {
        // The host reports a reading twenty minutes old, keeps serving it, and
        // takes a couple of seconds to answer. Neither that age nor the round
        // trip decides: one collection on the first view, then one per window
        // counted from each ask.
        const LATENCY_MS = 2_000;
        request.mockImplementation(() => new Promise<UsageNow>((resolve) => {
            setTimeout(() => resolve(collected(FRESH_MS / 1_000 + 60)), LATENCY_MS);
        }));
        mount();

        await tick(LATENCY_MS);
        expect(forcedReads()).toHaveLength(1);

        // The rest of that window collects nothing.
        await tick(FRESH_MS - 1_000 - LATENCY_MS);
        expect(forcedReads()).toHaveLength(1);

        // The window opens one collection...
        await tick(1_000 + LATENCY_MS);
        expect(forcedReads()).toHaveLength(2);

        // ...and the next is a whole window after that ask, not after the
        // answer that took a round trip to arrive.
        await tick(FRESH_MS - 1_000 - LATENCY_MS);
        expect(forcedReads()).toHaveLength(2);

        await tick(1_000 + LATENCY_MS);
        expect(forcedReads()).toHaveLength(3);
    });

    it('asks nothing inside the window on a host that cannot cache, and keeps painting', async () => {
        // The host never persists a reading, so every ask it is given collects.
        // Our own window keeps that to one per window, and the figure it gave us
        // is what a remount paints.
        request.mockResolvedValue(collected(undefined, 20, '2026-09-22T18:00:00.000Z'));
        let card = renderCard();
        await tick();
        expect(screenText(card)).toContain('80%');
        expect(request).toHaveBeenCalledTimes(1);
        TestRenderer.act(() => { card.unmount(); });

        // Repeated mounts, focus and foreground events inside the window ask
        // nothing at all, and still paint.
        request.mockClear();
        for (let event = 0; event < 3; event += 1) {
            await tick(60_000);
            card = renderCard();
            expect(screenText(card)).toContain('80%');
            TestRenderer.act(() => { appState.currentState = 'active'; appState.listeners.forEach((listener) => listener('active')); });
            await tick();
            expect(request).toHaveBeenCalledTimes(0);
            TestRenderer.act(() => { card.unmount(); });
        }
        expect(forcedReads()).toHaveLength(0);
    });

    it('always gives a tap on the unavailable card a read that bypasses the cache', async () => {
        let release: (value: UsageNow) => void = () => undefined;
        let hanging = false;
        request.mockImplementation(() => (hanging ? new Promise<UsageNow>((resolve) => { release = resolve; }) : Promise.resolve(COLLECTING)));
        const card = mount();
        await tick();
        for (let follow = 0; follow < 5; follow += 1) await tick(6_000);
        // The host never finished a collection, so the card reads unavailable.
        expect(card.latest().failed).toBe(true);

        // A retry tap asks past the cache, and is still in flight when a second
        // tap lands on it...
        hanging = true;
        TestRenderer.act(() => { card.latest().refresh(); });
        await tick();
        const inFlight = request.mock.calls.length;
        expect(request.mock.calls.at(-1)?.[1]).toEqual({ refresh: true });
        TestRenderer.act(() => { card.latest().refresh(); });
        expect(request.mock.calls.length).toBe(inFlight);

        // ...and that tap still ends in a read that bypasses the cache.
        await TestRenderer.act(async () => { release(COLLECTING); });
        await tick();
        expect(request.mock.calls.length).toBeGreaterThan(inFlight);
        expect(request.mock.calls.at(-1)?.[1]).toEqual({ refresh: true });
    });

    it('paints the last known figures on a remount inside the window without asking', async () => {
        request.mockResolvedValue(collected(undefined, 20, '2026-09-22T18:00:00.000Z'));
        let card = renderCard();
        await tick();
        expect(screenText(card)).toContain('80%');
        TestRenderer.act(() => { card.unmount(); });

        // A minute later -- well inside the window -- the card comes back, and
        // asks nothing: the reading we hold is what paints.
        await tick(60_000);
        request.mockClear();
        card = renderCard();
        expect(screenText(card)).toContain('80%');
        await tick();
        expect(request).toHaveBeenCalledTimes(0);
    });

    it('paints one of its three states on a fresh mount inside the window, and asks nothing', async () => {
        // The shared memory holds figures, a wait, or a failure -- and no fourth
        // state. Each one is what a fresh mount inside the window paints, with
        // no ask of its own.
        const states: { machine: string; answer: () => Promise<UsageNow>; shows: string }[] = [
            { machine: 'machine-figures', answer: () => Promise.resolve(collected(undefined, 20, '2026-09-22T18:00:00.000Z')), shows: '80%' },
            { machine: 'machine-waiting', answer: () => Promise.resolve(COLLECTING), shows: 'plugins.rightNow.collecting' },
            { machine: 'machine-unavailable', answer: () => Promise.reject(new Error('host unreachable')), shows: 'plugins.rightNow.unavailable' },
        ];
        for (const state of states) {
            connection.machineId = state.machine;
            request.mockReset();
            request.mockImplementation(state.answer);
            let card = renderCard();
            await tick();
            expect(screenText(card)).toContain(state.shows);
            TestRenderer.act(() => { card.unmount(); });

            // A fresh mount inside the window paints that state and asks nothing.
            await tick(6_000);
            request.mockClear();
            card = renderCard();
            expect(screenText(card)).toContain(state.shows);
            await tick();
            expect(request).toHaveBeenCalledTimes(0);
            TestRenderer.act(() => { card.unmount(); });
        }
    });

    it('asks immediately on the first view after switching machines', async () => {
        request.mockResolvedValue(collected(undefined, 100, '2026-09-22T15:00:00.000Z'));
        let card = renderCard();
        await tick();
        expect(screenText(card)).toContain('0%');
        expect(forcedReads()).toHaveLength(1);
        TestRenderer.act(() => { card.unmount(); });

        // Another machine is a different measurement: neither what we asked nor
        // what we held for the first one may carry over.
        connection.machineId = 'machine-two';
        request.mockClear();
        await tick(60_000);
        card = renderCard();

        expect(screenText(card)).not.toContain('0%');
        await tick();
        expect(forcedReads()).toHaveLength(1);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('never takes figures off the screen to refresh them, and says plainly when it could not', async () => {
        request.mockResolvedValueOnce(collected()).mockResolvedValueOnce(COLLECTING).mockRejectedValue(new Error('host unreachable'));
        const card = mount();
        await tick();
        const figures = figuresOf(card.latest());
        expect(figures?.limits.windows).toHaveLength(1);

        // The first view's own collection is recent enough that a tap has to
        // wait for the forced-read budget under it.
        await tick(11_000);

        // A forced refresh that comes back cold leaves the collected figures
        // exactly where they were, and shows that it is still working.
        TestRenderer.act(() => { card.latest().refresh(); });
        await tick();
        expect(request).toHaveBeenLastCalledWith('usage.now', { refresh: true }, expect.any(Number));
        expect(figuresOf(card.latest())).toEqual(figures);
        expect(card.latest().refreshing).toBe(true);

        // And a failed one keeps them too, while saying so.
        await tick(6_000);
        expect(figuresOf(card.latest())).toEqual(figures);
        expect(card.latest().failed).toBe(true);
        expect(card.latest().refreshing).toBe(false);
    });

    it('stops claiming to collect when the host never finishes, and does not keep asking', async () => {
        request.mockResolvedValue(COLLECTING);
        const card = mount();

        await tick();
        for (let follow = 0; follow < 5; follow += 1) await tick(6_000);

        // The first view collected once, and five follow-ups finished the burst:
        // it says so rather than collecting forever.
        expect(request).toHaveBeenCalledTimes(6);
        expect(card.latest().failed).toBe(true);
        expect(card.latest().display.status).toBe('unavailable');
        // The measured figures it did receive stay on screen behind that word.
        expect(vitalsOf(card.latest())).toEqual(VITALS);

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
        // The replaced figures were painted at age 3s; the collection a tap
        // starts answers six seconds later, so its capture is newer even though
        // its age is larger. Comparing raw ages alone would discard it and
        // exhaust the read into a false failure.
        request.mockResolvedValueOnce(collected(3)).mockResolvedValueOnce(COLLECTING).mockResolvedValue(collected(6));
        const card = mount();
        await tick();
        expect(figuresOf(card.latest())?.ageSeconds).toBe(3);

        await tick(11_000);
        TestRenderer.act(() => { card.latest().refresh(); });
        await tick();
        expect(card.latest().refreshing).toBe(true);

        await tick(6_000);
        expect(figuresOf(card.latest())?.ageSeconds).toBe(6);
        expect(card.latest().refreshing).toBe(false);

        const settled = request.mock.calls.length;
        await tick(60_000);
        expect(request).toHaveBeenCalledTimes(settled);
    });

    it('keeps waiting when a follow-up is answered by the same capture', async () => {
        // A replay carries the replaced capture: its age has grown by exactly
        // the time since those figures were painted, which is not a collection
        // finishing, so the read asks again -- and still accepts the collection
        // once it lands.
        request.mockResolvedValueOnce(collected(3)).mockResolvedValueOnce(COLLECTING).mockResolvedValueOnce(collected(20)).mockResolvedValue(collected(1));
        const card = mount();
        await tick();
        expect(figuresOf(card.latest())?.ageSeconds).toBe(3);

        await tick(11_000);
        TestRenderer.act(() => { card.latest().refresh(); });
        await tick();
        expect(card.latest().refreshing).toBe(true);

        await tick(6_000);
        expect(figuresOf(card.latest())?.ageSeconds).toBe(3);
        expect(card.latest().refreshing).toBe(true);

        await tick(6_000);
        expect(figuresOf(card.latest())?.ageSeconds).toBe(1);
        expect(card.latest().refreshing).toBe(false);
    });

    it('never accepts a replayed capture as newer when the host names the capture', async () => {
        const capture = '2026-09-22T10:00:00.000Z';
        // The host names the same capture on the replay, and the age it reports
        // grew by less than the elapsed time -- exactly the slow frame that
        // makes the age heuristic read a replay as newer.
        request.mockResolvedValueOnce(collected(3, 100, capture))
            .mockResolvedValueOnce(COLLECTING)
            .mockResolvedValueOnce(collected(7, 100, capture))
            .mockResolvedValue(collected(1, 100, '2026-09-22T10:20:00.000Z'));
        const card = mount();
        await tick();
        expect(figuresOf(card.latest())?.capturedAt).toBe(capture);

        await tick(11_000);
        TestRenderer.act(() => { card.latest().refresh(); });
        await tick();
        expect(card.latest().refreshing).toBe(true);

        await tick(6_000);
        expect(figuresOf(card.latest())?.capturedAt).toBe(capture);
        expect(card.latest().refreshing).toBe(true);

        await tick(6_000);
        expect(figuresOf(card.latest())?.capturedAt).toBe('2026-09-22T10:20:00.000Z');
        expect(card.latest().refreshing).toBe(false);
    });

    it('does not stack a cycle behind a read already in flight', async () => {
        let release: (value: UsageNow) => void = () => undefined;
        request.mockImplementation(() => new Promise<UsageNow>((resolve) => { release = resolve; }));
        const card = mount();
        await tick();
        // The first view's collection is in flight.
        expect(request).toHaveBeenCalledTimes(1);

        // The window opens and a cycle lands on it. Nothing is issued behind it...
        await tick(FRESH_MS);
        TestRenderer.act(() => { appState.currentState = 'active'; appState.listeners.forEach((listener) => listener('active')); });
        expect(request).toHaveBeenCalledTimes(1);

        // ...and the read in flight settles into the one collection it was.
        await TestRenderer.act(async () => { release(collected()); });
        await tick();
        expect(request).toHaveBeenCalledTimes(1);
        expect(forcedReads()).toHaveLength(1);
    });

    it('says a throttled tap is throttled when a person presses the card control', async () => {
        request.mockResolvedValue(collected());
        const card = renderCard();
        await tick();

        // The first view collected; a tap has to wait out the budget under it.
        await tick(11_000);

        // The next tap is honoured, past the host's cache.
        pressRefresh(card);
        await tick();
        expect(forcedReads()).toHaveLength(2);
        const read = request.mock.calls.length;

        // The next tap lands inside the window the first claimed: it is told
        // when it can run, and issues no cache-bypassing read of its own.
        pressRefresh(card);
        await tick();
        expect(refreshControls(card)[0].props.accessibilityLabel).toContain('plugins.rightNow.refreshThrottled');
        expect(screenText(card)).toContain('plugins.rightNow.refreshIn');
        expect(request.mock.calls.length).toBe(read);
        expect(forcedReads()).toHaveLength(2);
    });

    it('lets a tap on the card control re-collect straight after a failure', async () => {
        request.mockResolvedValueOnce(collected()).mockRejectedValueOnce(new Error('host unreachable')).mockResolvedValue(collected());
        const card = renderCard();
        await tick();
        await tick(11_000);

        pressRefresh(card);
        await tick(1_000);
        expect(screenText(card)).toContain('plugins.rightNow.refreshFailed');

        // Someone already looking at an error is being told to try again: that
        // tap bypasses the cache, even one second after the last read.
        pressRefresh(card);
        await tick();
        expect(forcedReads()).toHaveLength(3);
    });

    it('runs a tap refused by a read in flight past the cache once that read settles', async () => {
        let release: (value: UsageNow) => void = () => undefined;
        request.mockRejectedValueOnce(new Error('host unreachable'))
            .mockImplementationOnce(() => new Promise<UsageNow>((resolve) => { release = resolve; }))
            .mockResolvedValue(collected());
        const card = renderCard();
        await tick();
        // The first read failed with nothing to show, so the card offers a retry.
        expect(screenText(card)).toContain('plugins.rightNow.unavailable');

        // The retry asks past the cache, and is still in flight when a second
        // tap lands on it.
        const before = forcedReads().length;
        press(card, 'plugins.rightNow.unavailable');
        const inFlight = forcedReads().length;
        expect(inFlight).toBe(before + 1);
        press(card, 'plugins.rightNow.unavailable');
        expect(forcedReads()).toHaveLength(inFlight);

        // It is not answered by that read: it runs past the cache the moment
        // the read settles.
        await TestRenderer.act(async () => { release(collected()); });
        await tick();
        expect(forcedReads()).toHaveLength(inFlight + 1);
        expect(request).toHaveBeenLastCalledWith('usage.now', { refresh: true }, expect.any(Number));
    });
});

describe('the usage screen read path', () => {
    it('marks the tab the host answered for when the default view opens', async () => {
        // The default view asks for no tab; the host picks one, and it need not
        // be the first pill. That pill is the one the figures belong to.
        request.mockResolvedValue(report('opencode', 0));
        const screen = renderScreen();
        await tick();
        const selected = screen.root.findAll((node: any) => node.props?.accessibilityRole === 'tab' && node.props?.onPress !== undefined)
            .map((node: any) => [node.props.accessibilityLabel, node.props.accessibilityState?.selected]);
        expect(selected).toEqual([['Claude', false], ['OpenCode', true]]);
    });

    it('names a refused tap at the control that was pressed', async () => {
        request.mockResolvedValue(report('claude', 1_200));
        const screen = renderScreen();
        await tick();
        // The first view collected once, spending the forced-read budget.
        expect(forcedReads()).toHaveLength(1);

        const control = refreshControls(screen)[0];
        expect(control).toBeDefined();
        TestRenderer.act(() => { control.props.onPress(); });
        await tick();

        // The refusal is named on the button itself, with its countdown, and it
        // gets the same feedback as a press that ran.
        const pressed = refreshControls(screen)[0];
        expect(hapticsSelection).toHaveBeenCalled();
        expect(pressed.props.accessibilityLabel).toContain('plugins.rightNow.refreshThrottled');
        expect(pressed.findAllByType('Text').map((node: any) => node.props.children).join(' ')).toContain('plugins.rightNow.refreshIn');
        expect(forcedReads()).toHaveLength(1);

        // It lives with the control, above the list, so scrolling cannot take it
        // away from the tap that produced it.
        const list = screen.root.findAllByType('ScrollView')[0];
        expect(list.findAllByType('Text').some((node: any) => node.props.children === 'plugins.rightNow.refreshIn')).toBe(false);
    });

    it('collects once for a tab across opening, re-entry and foreground, and at once for a tab nobody asked', async () => {
        // The phone arrives on figures twenty minutes old; every later read
        // inside the window is served a same-day entry the host still marks
        // stale at sixty seconds.
        const cachedAt: Record<string, number> = { claude: Date.now() - 20 * 60_000, opencode: Date.now() - 90_000 };
        request.mockImplementation((_method: string, params?: { provider?: string; refresh?: boolean }) => {
            const tab = params?.provider ?? 'claude';
            if (params?.refresh === true) cachedAt[tab] = Date.now();
            return Promise.resolve(report(tab, Math.max(0, Math.round((Date.now() - cachedAt[tab]) / 1_000))));
        });

        // Opening asks for the collection itself...
        let screen = renderScreen();
        await tick();
        expect(request.mock.calls[0]?.[1]).toEqual({ refresh: true });
        // ...which is the only ask this screen makes.
        expect(forcedReads()).toHaveLength(1);

        // Re-entry...
        await tick(90_000);
        TestRenderer.act(() => { screen.unmount(); });
        screen = renderScreen();
        await tick();
        // ...and a return from the background, both inside the same window.
        await tick(90_000);
        TestRenderer.act(() => { appState.currentState = 'active'; appState.listeners.forEach((listener) => listener('active')); });
        await tick();
        expect(forcedReads()).toHaveLength(1);

        // A tab nobody has asked is its own window: it asks at once, and
        // asking it does not hand claude another collection.
        await tick(90_000);
        press(screen, 'OpenCode');
        await tick();
        expect(forcedReads()).toHaveLength(2);
        expect(forcedReads()[1]?.[1]).toMatchObject({ provider: 'opencode' });
    });

    it('asks at most once per window when the host cannot store a reading', async () => {
        // The host declines to cache a reading whose limits or activity are
        // unavailable, so the same old one is served forever: its age can no
        // longer open the window, only our own record of asking can.
        request.mockImplementation((_method: string, params?: { provider?: string }) =>
            Promise.resolve(report(params?.provider ?? 'claude', 1_200)));

        let screen = renderScreen();
        await tick();
        expect(forcedReads()).toHaveLength(1);

        // Reopen...
        await tick(90_000);
        TestRenderer.act(() => { screen.unmount(); });
        screen = renderScreen();
        await tick();
        // ...and a return from the background, still inside the window.
        await tick(90_000);
        TestRenderer.act(() => { appState.currentState = 'active'; appState.listeners.forEach((listener) => listener('active')); });
        await tick();

        expect(forcedReads()).toHaveLength(1);
    });

    it('paints the state the card left, rather than nothing, when the window is already claimed', async () => {
        const claimed = Date.now();
        request.mockClear();
        noteAsked('', claimed - 1_000);
        rememberShown('', { status: 'waiting', askedAt: claimed });
        let screen = renderScreen();
        await tick();
        expect(screenText(screen)).toContain('plugins.rightNow.collecting');
        expect(request).toHaveBeenCalledTimes(0);
        TestRenderer.act(() => { screen.unmount(); });

        // The card's own read answers with usage.now figures: the screen paints
        // the limits it carries and dashes the activity it never had, and asks
        // for the tab list that record cannot name.
        rememberShown('', { status: 'figures', at: claimed, figures: withNow(undefined, collected(undefined, 20)) });
        request.mockImplementation(() => Promise.resolve(report('claude', 60)));
        screen = renderScreen();
        expect(screenText(screen)).toContain('—');
        await tick();
        expect(request).toHaveBeenCalledTimes(1);
        TestRenderer.act(() => { screen.unmount(); });
        request.mockClear();

        // A failure says so, with the way back.
        rememberShown('', { status: 'unavailable', reason: 'host unreachable' });
        screen = renderScreen();
        await tick();
        expect(screenText(screen)).toContain('plugins.retry');
        expect(request).toHaveBeenCalledTimes(0);
        expect(screen.root.findAll((node: any) => node.props?.accessibilityLabel === 'host unreachable. plugins.retry').length).toBeGreaterThan(0);
        TestRenderer.act(() => { screen.unmount(); });

        // A failure the store carries no words for still says what it is.
        rememberShown('', { status: 'unavailable', reason: '' });
        screen = renderScreen();
        await tick();
        expect(screen.root.findAll((node: any) => node.props?.text === 'plugins.rightNow.unavailable').length).toBeGreaterThan(0);
        expect(screen.root.findAll((node: any) => node.props?.accessibilityLabel === 'plugins.rightNow.unavailable. plugins.retry').length).toBeGreaterThan(0);
    });

    it('shows what the other surface learns without a remount', async () => {
        // The card asks for the default tab, and the host answers that it is
        // still collecting.
        let answer: Promise<UsageNow> = Promise.resolve(COLLECTING);
        request.mockImplementation((method: string) => (method === 'usage.now' ? answer : new Promise<UsageReport>(() => undefined)));
        const card = renderCard();
        await tick();
        expect(screenText(card)).toContain('plugins.rightNow.collecting');

        // The screen opens on that same tab -- the same wait, and no ask of its
        // own -- and the card's follow-up lands with figures while it is open.
        const screen = renderScreen();
        await tick();
        expect(screenText(screen)).toContain('plugins.rightNow.collecting');
        answer = Promise.resolve(collected(undefined, 20, '2026-09-22T18:00:00.000Z'));
        await tick(6_000);
        expect(screenText(screen)).toContain('—');
        TestRenderer.act(() => { card.unmount(); });
    });

    it('honours a retry press while another tab has a read in flight', async () => {
        // opencode was asked a moment ago and its reading failed; claude's read
        // is the one in flight.
        noteAsked('opencode', Date.now());
        rememberShown('opencode', { status: 'unavailable', reason: 'host unreachable' });
        let release: (value: UsageReport) => void = () => undefined;
        request.mockImplementation((_method: string, params?: { provider?: string }) => (params?.provider === 'claude'
            ? new Promise<UsageReport>((resolve) => { release = resolve; })
            : Promise.resolve(report('claude', 60))));
        const screen = renderScreen();
        await tick();
        press(screen, 'Claude');
        await tick();
        press(screen, 'OpenCode');
        await tick();
        const before = request.mock.calls.length;

        // The retry is pressed while that read is still running...
        press(screen, 'host unreachable. plugins.retry');
        expect(request.mock.calls.length).toBe(before);

        // ...and it is not swallowed: it runs, past the cache, once the read in
        // flight has settled.
        await TestRenderer.act(async () => { release(report('claude', 60)); });
        await tick();
        expect(request.mock.calls.length).toBeGreaterThan(before);
        expect(request.mock.calls.at(-1)?.[1]).toEqual({ provider: 'opencode', refresh: true });
    });

    it('shows every plan\'s limits at once, in places a reader can learn, coloured only where little is left', async () => {
        // The host lists plans most urgent first and each plan's windows in its
        // own order. The card holds its own order instead: plans by name, so a
        // plan keeps its place as its figures move, and windows shortest first.
        const now: UsageNow = {
            limits: { verdict: 'limited', windows: [{ label: 'Weekly', window: '7d', used: 100 }] },
            connected: [
                { id: 'opencode', label: 'OpenCode', glyph: 'opencode', plan: 'OpenCode Go', windows: [
                    // A billing month publishes no length and no pace, and is no less low for it.
                    { label: 'Monthly', used: 92, pace: null, resetsIn: '18d' },
                    { label: 'Weekly', window: '7d', used: 100, pace: 'limited', resetsIn: '1d 5h' },
                    { label: 'Rolling', window: '5h', used: 7, pace: 'on pace' },
                ] },
                { id: 'codex', label: 'Codex', glyph: 'codex', plan: 'OpenAI Codex', windows: [
                    { label: 'Weekly', window: '7d', used: 11 },
                    { label: 'Spark · Session', window: '5h', used: 40 },
                    { label: 'Session', window: '5h', used: 2 },
                ] },
                // A share that is not a number is not a reading: it is left out,
                // never printed, and a plan with nothing readable has no column.
                { id: 'claude', label: 'Claude', glyph: 'claude', plan: 'Claude plan', windows: [
                    { label: 'Weekly', window: '7d', used: 64 },
                    { label: 'Session', window: '5h', used: Number.NaN },
                ] },
                { id: 'zai', label: 'Z.ai', windows: [{ label: 'Session', window: '5h', used: Number.NaN }] },
            ],
            vitals: VITALS,
        };
        noteAsked('', Date.now());
        rememberShown('', { status: 'figures', at: Date.now(), figures: withNow(undefined, now) });
        const card = renderCard();
        await tick();

        expect(card.root.findAllByType('AgentGlyph').map((mark: any) => mark.props.name)).toEqual(['claude', 'codex', 'opencode']);
        // Each plan's figures under its mark, shortest window first, each tagged
        // with its window: no table, so no empty cell for a length a plan lacks.
        // Two limits of one length show the tighter and say there are two.
        const figures = () => card.root.findAllByType('Text')
            .map((node: any) => [node.props.children, node.props.style?.color])
            .filter(([text]: any) => typeof text === 'string' && !text.startsWith('plugins.rightNow.memory'));
        expect(figures()).toEqual([
            ['36%', '#fff'], ['7d', '#999'],
            ['60%', '#fff'], ['5h×2', '#999'], ['89%', '#fff'], ['7d', '#999'],
            ['93%', '#fff'], ['5h', '#999'], ['0%', 'tone:danger'], ['7d', '#999'], ['8%', 'tone:warning'], ['Month…', '#999'],
        ]);
        // Read aloud in the same order, naming every limit, and a coloured
        // figure says why and when it comes back, which its colour cannot.
        const summary: string = card.root.findAll((node: any) => node.props?.accessibilityRole === 'button' && node.props?.onPress !== undefined
            && String(node.props.accessibilityLabel).startsWith('plugins.rightNow.title.'))[0]!.props.accessibilityLabel;
        expect(summary.indexOf('Claude plan')).toBeLessThan(summary.indexOf('OpenAI Codex'));
        expect(summary.indexOf('OpenAI Codex')).toBeLessThan(summary.indexOf('OpenCode Go'));
        expect(summary).toContain('Spark · Session 5h 60% plugins.limits.percentLeft, Session 5h 98% plugins.limits.percentLeft');
        expect(summary).toContain('7d 0% plugins.limits.percentLeft (plugins.limits.paceExhausted, plugins.rightNow.resetsIn(1d 5h))');
        expect(summary).toContain('Monthly 8% plugins.limits.percentLeft (plugins.limits.low, plugins.rightNow.resetsIn(18d))');
        expect(summary).not.toContain('Z.ai');

        const longName = `${'model-'.repeat(12)}session`;
        const otherName = `${'model-'.repeat(12)}weekly`;
        const namedNow: UsageNow = {
            ...now,
            connected: now.connected!.map((provider) => provider.id === 'codex'
                ? { ...provider, windows: [...provider.windows,
                    { label: 'gpt-4', used: 17 }, { label: 'gpt-5', used: 23 },
                    { label: 'gpt-4-turbo', used: 52 }, { label: 'gpt-4-vision', used: 71 },
                    { label: 'GPT-5.3-Codex-Spark · Limit', used: 65 }, { label: 'GPT-5.3-Codex-Mini · Limit', used: 76 },
                    { label: longName, used: 31 }, { label: otherName, used: 42 },
                ] }
                : provider),
        };
        TestRenderer.act(() => { rememberShown('', { status: 'figures', at: Date.now() + 1, figures: withNow(undefined, namedNow) }); });
        const codexText = () => card.root.findAllByType('AgentGlyph')[1]!.parent.findAllByType('Text')
            .map((node: any) => node.props.children) as string[];
        const codexTags = codexText().filter((text) => !text.endsWith('%'));
        expect(codexTags).toContain('gpt-4');
        expect(codexTags).toContain('gpt-5');
        expect(screenText(card)).toContain('Month…');
        expect(new Set(codexTags).size).toBe(codexTags.length);
        expect(codexTags.every((tag) => tag.length <= 6)).toBe(true);
        const namedShares = () => Object.fromEntries(codexText().filter((_, index) => index % 2 === 1)
            .map((tag, index) => [tag, codexText()[index * 2]]));
        expect(namedShares()).toMatchObject({ turbo: '48%', vision: '29%', Spark: '35%', Mini: '24%' });
        TestRenderer.act(() => { rememberShown('', { status: 'figures', at: Date.now() + 2, figures: withNow(undefined, {
            ...namedNow,
            connected: namedNow.connected!.map((provider) => provider.id === 'codex'
                ? { ...provider, windows: [...provider.windows].reverse() }
                : provider),
        }) }); });
        expect(namedShares()).toMatchObject({ turbo: '48%', vision: '29%', Spark: '35%', Mini: '24%' });
        expect(figures()).toContainEqual(['83%', '#fff']);
        expect(screenText(card)).not.toContain(longName);
        const cardButton = () => card.root.findAll((node: any) => node.props?.accessibilityRole === 'button'
            && String(node.props.accessibilityLabel).startsWith('plugins.rightNow.title.'))[0]!;
        const updatedLabel: string = cardButton().props.accessibilityLabel;
        expect(updatedLabel).toContain('gpt-4');
        expect(updatedLabel).toContain('gpt-5');
        expect(updatedLabel).toContain('gpt-4-turbo');
        expect(updatedLabel).toContain('GPT-5.3-Codex-Spark · Limit');
        expect(updatedLabel).toContain(longName);
        expect(updatedLabel).toContain(otherName);
        TestRenderer.act(() => { cardButton().props.onLongPress(); });
        expect(screenText(card)).toContain(longName);
        expect(screenText(card)).toContain(otherName);
        TestRenderer.act(() => { cardButton().props.onPress(); });
        expect(screenText(card)).not.toContain(longName);
    });

    it('shows connected limits even when the selected plan has no windows', async () => {
        const now: UsageNow = {
            limits: { verdict: 'unknown', windows: [], message: 'Selected plan unavailable' },
            connected: [{ id: 'codex', label: 'Codex', windows: [
                { label: 'Session', window: '5h', used: 20 },
                { label: 'Weekly', window: '7d', used: 60 },
            ] }],
        };
        request.mockResolvedValueOnce(now).mockResolvedValueOnce(COLLECTING).mockResolvedValueOnce({
            limits: { verdict: 'unknown', windows: [], message: 'Selected plan unavailable' },
        } satisfies UsageNow);
        const card = renderCard();
        await tick();

        expect(card.root.findAllByType('AgentGlyph').map((mark: any) => mark.props.name)).toEqual(['codex']);
        expect(screenText(card)).toContain('80%');
        expect(screenText(card)).toContain('40%');
        expect(screenText(card)).not.toContain('Selected plan unavailable');
        const label: string = card.root.findAll((node: any) => node.props?.accessibilityRole === 'button'
            && String(node.props.accessibilityLabel).startsWith('plugins.rightNow.title.'))[0]!.props.accessibilityLabel;
        expect(label).toContain('5h 80% plugins.limits.percentLeft');
        expect(label).toContain('7d 40% plugins.limits.percentLeft');
        expect(label).not.toContain('Selected plan unavailable');

        await tick(11_000);
        pressRefresh(card);
        await tick();
        expect(screenText(card)).toContain('80%');
        expect(card.root.findAllByType('AgentGlyph')).toHaveLength(1);

        await tick(6_000);
        expect(screenText(card)).toContain('Selected plan unavailable');
        expect(screenText(card)).not.toContain('80%');
        expect(card.root.findAllByType('AgentGlyph')).toHaveLength(0);
        const disconnectedLabel: string = card.root.findAll((node: any) => node.props?.accessibilityRole === 'button'
            && String(node.props.accessibilityLabel).startsWith('plugins.rightNow.title.'))[0]!.props.accessibilityLabel;
        expect(disconnectedLabel).toContain('Selected plan unavailable');
        expect(disconnectedLabel).not.toContain('Codex');
    });

    it('shows a single plan with matching visible and spoken remaining share on Home', async () => {
        const now: UsageNow = { limits: { verdict: 'low', windows: [{ label: 'Rolling', window: '5h', used: 92, elapsed: 0.3 }] } };
        noteAsked('', Date.now());
        rememberShown('', { status: 'figures', at: Date.now(), figures: withNow(undefined, now) });
        const card = renderCard();
        await tick();
        expect(screenText(card)).toContain('8% plugins.limits.percentLeft');
        const openUsage = card.root.findAll((node: any) => node.props?.accessibilityLabel?.includes('Rolling 5h'))[0];
        expect(openUsage.props.accessibilityLabel).toContain('8% plugins.limits.percentLeft');
    });

    it('shows the same remaining share and time-left tick on the Usage limit meter', async () => {
        const { ScreenLimits } = await import('@/plugins/presentation/screenLimits');
        let renderer: any;
        TestRenderer.act(() => {
            renderer = TestRenderer.create(<ScreenLimits node={{ type: 'limits', path: 'limits' }} data={{
                limits: { verdict: 'low', windows: [{ label: 'Rolling', window: '5h', used: 92, elapsed: 0.3 }] },
            }} />);
        });
        mounted.push(renderer!);
        expect(screenText(renderer)).toContain('8% plugins.limits.percentLeft');
        const bar = renderer.root.findByType('Meter');
        expect(bar.props.ratio).toBeCloseTo(0.08);
        expect(bar.props.marker).toBeCloseTo(0.7);
    });

    it('says what it holds when the figures name no connected plan', async () => {
        // A machine with local agents but no plan whose limits could be read:
        // the host sends no connected list, and its own reason on the limits.
        noteAsked('', Date.now() - 1_000);
        rememberShown('', { status: 'figures', at: Date.now(), figures: withNow(undefined, { limits: { verdict: 'unknown', windows: [], message: "Plan limits aren't connected" }, ageSeconds: 20 }) });
        request.mockClear();
        request.mockImplementation(() => new Promise<UsageReport>(() => undefined));
        const screen = renderScreen();
        await tick();
        expect(request).toHaveBeenCalledTimes(1);
        expect(screen.root.findAllByType('ScreenLimits').length).toBeGreaterThan(0);
        expect(screenText(screen)).toContain('—');
    });

    it('leaves the window askable again when a read is abandoned', async () => {
        // The screen's read is abandoned before it answers: the reader backs out
        // while the collection runs.
        request.mockImplementation(() => new Promise<UsageReport>(() => undefined));
        let screen = renderScreen();
        await tick();
        expect(request).toHaveBeenCalledTimes(1);
        TestRenderer.act(() => { screen.unmount(); });

        // Coming back asks again: no answer was coming for the abandoned read,
        // so the tab is back to not having been asked.
        screen = renderScreen();
        await tick();
        expect(request).toHaveBeenCalledTimes(2);

        // The card's own read follows the same rule.
        request.mockClear();
        connection.machineId = 'machine-abandoned-card';
        let card = renderCard();
        await tick();
        expect(request).toHaveBeenCalledTimes(1);
        TestRenderer.act(() => { card.unmount(); });
        card = renderCard();
        await tick();
        expect(request).toHaveBeenCalledTimes(2);
        TestRenderer.act(() => { card.unmount(); });
    });

    it('keeps the window claimed when the host answered with a failure', async () => {
        request.mockRejectedValue(new Error('host unreachable'));
        let screen = renderScreen();
        await tick();
        expect(request).toHaveBeenCalledTimes(1);
        expect(screenText(screen)).toContain('plugins.retry');
        TestRenderer.act(() => { screen.unmount(); });

        // The host did the work and answered, so a second view inside the window
        // does not ask it again.
        screen = renderScreen();
        await tick();
        expect(request).toHaveBeenCalledTimes(1);
        expect(screenText(screen)).toContain('plugins.retry');
    });

    it('names a failed refresh at the control rather than passing it off as success', async () => {
        request.mockResolvedValueOnce(report('claude', 60)).mockRejectedValue(new Error('host unreachable'));
        const screen = renderScreen();
        await tick();
        expect(screenText(screen)).toContain('OpenCode');

        await tick(11_000);
        TestRenderer.act(() => { refreshControls(screen)[0].props.onPress(); });
        await tick();

        // The figures stay, and the press is named as a failure rather than
        // looking exactly like a refresh that worked.
        expect(screenText(screen)).toContain('OpenCode');
        expect(screenText(screen)).toContain('plugins.rightNow.refreshFailed');
        expect(refreshControls(screen)[0].props.accessibilityLabel).toContain('plugins.rightNow.refreshFailed');
    });

    it('asks for the host tab list when the record it holds names no tabs, then asks nothing more', async () => {
        // The card asked first and wrote its own figures: limits and plans, no
        // tab list. That record answers the card's question, not this screen's.
        const claimed = Date.now();
        noteAsked('', claimed - 1_000);
        rememberShown('', { status: 'figures', at: claimed, figures: withNow(undefined, collected(undefined, 20)) });
        request.mockClear();
        request.mockResolvedValue(report('claude', 60));
        let screen = renderScreen();
        await tick();

        // One ask, and every tab the host names is there.
        expect(request).toHaveBeenCalledTimes(1);
        expect(screenText(screen)).toContain('Claude');
        expect(screenText(screen)).toContain('OpenCode');

        // That ask claimed the window, so a second view asks nothing.
        TestRenderer.act(() => { screen.unmount(); });
        request.mockClear();
        screen = renderScreen();
        await tick();
        expect(request).toHaveBeenCalledTimes(0);
        expect(screenText(screen)).toContain('OpenCode');
    });

    it('asks nothing inside the window when the record answers this screen', async () => {
        const claimed = Date.now();
        noteAsked('', claimed);
        rememberShown('', { status: 'figures', at: claimed, figures: withReport(undefined, report('claude', 60)) });
        request.mockClear();
        const screen = renderScreen();
        await tick();
        expect(request).toHaveBeenCalledTimes(0);
        expect(screenText(screen)).toContain('OpenCode');
    });

    it('leaves the tab of a superseded read askable again', async () => {
        let hanging = false;
        request.mockImplementation((method: string, params?: { provider?: string }) => {
            if (method === 'usage.now') return Promise.resolve(collected());
            if (hanging) return new Promise<UsageReport>(() => undefined);
            return Promise.resolve(report(params?.provider ?? 'claude', 60));
        });
        const screen = renderScreen();
        await tick();
        expect(request).toHaveBeenCalledTimes(1);

        // The window opens and its read is in flight when a tab switch takes
        // over: the default tab's answer is dropped, so its claim goes with it.
        hanging = true;
        await tick(FRESH_MS);
        expect(request).toHaveBeenCalledTimes(2);
        press(screen, 'Claude');
        await tick();

        // The abandoned claim went with its read: the card, which reads the same
        // tab, is not locked out of it.
        request.mockClear();
        const card = renderCard();
        await tick();
        expect(request).toHaveBeenCalledTimes(1);
        TestRenderer.act(() => { card.unmount(); });
    });

    it('names a failure for the tab it happened on, not for the tab selected next', async () => {
        // opencode has healthy figures of its own, inside its window.
        noteAsked('opencode', Date.now());
        rememberShown('opencode', { status: 'figures', at: Date.now(), figures: withReport(undefined, report('opencode', 60)) });
        request.mockImplementation((_method: string, params?: { provider?: string }) => (params?.provider === 'claude'
            ? Promise.reject(new Error('host unreachable'))
            : Promise.resolve(report('claude', 60))));
        const screen = renderScreen();
        await tick();
        press(screen, 'Claude');
        await tick();
        expect(screenText(screen)).toContain('plugins.rightNow.refreshFailed');

        // Switching to a tab that never failed does not carry the word over.
        press(screen, 'OpenCode');
        await tick();
        expect(screenText(screen)).not.toContain('plugins.rightNow.refreshFailed');
    });

    it('lets a retry press reach the host after a rejection behind figures', async () => {
        request.mockResolvedValueOnce(report('claude', 60)).mockRejectedValue(new Error('host unreachable'));
        const screen = renderScreen();
        await tick();
        expect(screenText(screen)).toContain('OpenCode');

        // A refresh that fails behind figures keeps them and is named at the
        // control...
        await tick(11_000);
        TestRenderer.act(() => { refreshControls(screen)[0].props.onPress(); });
        await tick();
        expect(screenText(screen)).toContain('plugins.rightNow.refreshFailed');

        // ...and the retry is not throttled: the rejected read spent no quota.
        const before = request.mock.calls.length;
        TestRenderer.act(() => { refreshControls(screen)[0].props.onPress(); });
        await tick();
        expect(request.mock.calls.length).toBeGreaterThan(before);
    });

    it('keeps every window the screen holds when the card writes its own', async () => {
        // A report with two windows is what this screen renders.
        const held: UsageReport = { ...report('claude', 60), limits: { verdict: 'limited', windows: [{ label: 'Five hour', used: 70 }, { label: 'Seven day', used: 40 }] } };
        const claimed = Date.now();
        noteAsked('', claimed - 1_000);
        rememberShown('', { status: 'figures', at: claimed, figures: withReport(undefined, held) });
        const screen = renderScreen();
        const windows = () => screen.root.findAllByType('ScreenLimits')[0].props.data.limits.windows.length;
        expect(windows()).toBe(2);

        // The card's own read lands for the same tab: it names one window, and
        // the screen's list is not narrowed by it.
        const stored = shownUsage('');
        TestRenderer.act(() => { rememberShown('', { status: 'figures', at: claimed + 1, figures: withNow(stored?.status === 'figures' ? stored.figures : undefined, collected(undefined, 20)) }); });
        expect(windows()).toBe(2);
        const figures = shownUsage('');
        expect(figures?.status === 'figures' ? figures.figures.cardWindow?.used : undefined).toBe(20);

        TestRenderer.act(() => { rememberShown('', { status: 'figures', at: claimed + 2, figures: withNow(
            figures?.status === 'figures' ? figures.figures : undefined,
            { limits: { verdict: 'unknown', windows: [], message: 'Plan limits unavailable' } },
        ) }); });
        expect(windows()).toBe(0);
        expect(screen.root.findAllByType('ScreenLimits')[0].props.data.limits.message).toBe('Plan limits unavailable');
        const emptied = shownUsage('');
        expect(emptied?.status === 'figures' ? emptied.figures.cardWindow : undefined).toBeUndefined();
    });

    it('asks once for the tab list, and not again when that ask fails', async () => {
        // The card's figures name no tabs, and the ask for them fails.
        const claimed = Date.now();
        noteAsked('', claimed - 1_000);
        rememberShown('', { status: 'figures', at: claimed, figures: withNow(undefined, collected(undefined, 20)) });
        request.mockClear();
        request.mockRejectedValue(new Error('host unreachable'));
        let screen = renderScreen();
        await tick();
        expect(request).toHaveBeenCalledTimes(1);

        // The record still names no tabs, but its round is spent: a remount and
        // a foreground return inside the window ask nothing more.
        TestRenderer.act(() => { screen.unmount(); });
        screen = renderScreen();
        await tick();
        expect(request).toHaveBeenCalledTimes(1);
        TestRenderer.act(() => { appState.currentState = 'active'; appState.listeners.forEach((listener) => listener('active')); });
        await tick();
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('drops the card window a newer answer says does not exist', async () => {
        // The card's read names one window; a later report for the same tab
        // reports no window figures at all.
        const claimed = Date.now();
        noteAsked('', claimed - 1_000);
        rememberShown('', { status: 'figures', at: claimed, figures: withNow(undefined, collected(undefined, 20)) });
        const card = renderCard();
        expect(screenText(card)).toContain('80%');

        const planless: UsageReport = { ...report('claude', 60), limits: { verdict: 'unknown', windows: [], message: 'Claude plan limits unavailable' } };
        const held = shownUsage('');
        TestRenderer.act(() => { rememberShown('', { status: 'figures', at: claimed + 1, figures: withReport(held?.status === 'figures' ? held.figures : undefined, planless) }); });

        // The refuted window is gone, and the host's own words take its place.
        expect(screenText(card)).not.toContain('80%');
        expect(screenText(card)).toContain('Claude plan limits unavailable');
    });

    it('still asks for the tab list when an unrelated ask has landed', async () => {
        // The card's figures name no tabs, and a later ask on the same tab
        // produced no record at all: that ask answered nothing of this screen's.
        const claimed = Date.now();
        noteAsked('', claimed);
        rememberShown('', { status: 'figures', at: claimed - 1_000, figures: withNow(undefined, collected(undefined, 20)) });
        request.mockClear();
        request.mockResolvedValue(report('claude', 60));
        const screen = renderScreen();
        await tick();

        expect(request).toHaveBeenCalledTimes(1);
        expect(screenText(screen)).toContain('OpenCode');
    });

    it('keeps one budget across surfaces, so a press on the other is refused', async () => {
        request.mockImplementation((method: string, params?: { provider?: string }) => (method === 'usage.now'
            ? Promise.resolve(collected())
            : Promise.resolve(report(params?.provider ?? 'claude', 60))));
        // The card's read arms the budget...
        const card = renderCard();
        await tick();

        // ...and the screen, mounting seconds later on the same tab, cannot spend
        // it again: the press is refused, and named at the control.
        await tick(2_000);
        rememberShown('', { status: 'figures', at: Date.now(), figures: withReport(undefined, report('claude', 60)) });
        request.mockClear();
        const screen = renderScreen();
        await tick();
        expect(request).toHaveBeenCalledTimes(0);
        TestRenderer.act(() => { refreshControls(screen)[0].props.onPress(); });
        await tick();
        expect(request).toHaveBeenCalledTimes(0);
        expect(screenText(screen)).toContain('plugins.rightNow.refreshIn');
        TestRenderer.act(() => { card.unmount(); });
    });

    it('does not start a second forced read from a remount inside the budget', async () => {
        request.mockResolvedValue(report('claude', 60));
        let screen = renderScreen();
        await tick();
        TestRenderer.act(() => { screen.unmount(); });

        await tick(3_000);
        request.mockClear();
        screen = renderScreen();
        await tick();
        expect(request).toHaveBeenCalledTimes(0);
        TestRenderer.act(() => { refreshControls(screen)[0].props.onPress(); });
        await tick();
        expect(request).toHaveBeenCalledTimes(0);
        expect(screenText(screen)).toContain('plugins.rightNow.refreshIn');
    });

    it('collects exactly once per window for a tab the host has nothing stored for', async () => {
        // The host cannot store this tab, so every request for it is a whole
        // collection: the request count is the collection count.
        request.mockImplementation((_method: string, params?: { provider?: string }) =>
            Promise.resolve(report(params?.provider ?? 'claude', 60)));
        let screen = renderScreen();
        await tick();
        expect(request).toHaveBeenCalledTimes(1);

        // A second view inside the window asks nothing at all, and still paints
        // the report it holds.
        await tick(90_000);
        TestRenderer.act(() => { screen.unmount(); });
        screen = renderScreen();
        await tick();
        expect(request).toHaveBeenCalledTimes(1);
        expect(screenText(screen)).toContain('OpenCode');

        // The window opens: exactly one more.
        await tick(FRESH_MS);
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('leaves the screen usable when a tab switch skips the ask of a read in flight', async () => {
        let release: (value: UsageReport) => void = () => undefined;
        let hanging = false;
        request.mockImplementation((_method: string, params?: { provider?: string }) => {
            if (hanging) return new Promise<UsageReport>((resolve) => { release = resolve; });
            return Promise.resolve(report(params?.provider ?? 'claude', 60));
        });
        let screen = renderScreen();
        await tick();
        press(screen, 'Claude');
        await tick();
        TestRenderer.act(() => { screen.unmount(); });

        // A window later the default tab's read is in flight again...
        await tick(FRESH_MS);
        hanging = true;
        screen = renderScreen();
        await tick();
        const inFlight = request.mock.calls.length;

        // ...when the reader switches to the tab whose report is already held,
        // which has nothing to ask.
        noteAsked('claude', Date.now() - 60_000);
        press(screen, 'Claude');
        await tick();
        expect(request.mock.calls.length).toBe(inFlight);

        // The abandoned read settles, and nothing is left latched: the hairline
        // is off and the refresh control works.
        await TestRenderer.act(async () => { release(report('claude', 60)); });
        await tick();
        const control = refreshControls(screen)[0];
        expect(control.props.disabled).toBe(false);
        expect(control.props.accessibilityState.busy).toBe(false);
    });

    it('refreshes once per window against a host that reports no age at all', async () => {
        // An older host carries no age for the reading it served, and still
        // marks it stale at sixty seconds. Neither decides: opening collects
        // once, the rest of the window collects nothing, and the window's end
        // collects once more.
        const noAge = { ...report('claude', 1_200) };
        delete noAge.ageSeconds;
        request.mockImplementation((_method: string, params?: { provider?: string }) =>
            Promise.resolve({ ...noAge, provider: params?.provider ?? 'claude' }));

        renderScreen();
        await tick();
        expect(forcedReads()).toHaveLength(1);

        await tick(FRESH_MS - 1_000);
        expect(forcedReads()).toHaveLength(1);

        await tick(2_000);
        expect(forcedReads()).toHaveLength(2);
    });

    it('shows the read a pull lands on rather than a gesture that did nothing', async () => {
        let release: (value: UsageReport) => void = () => undefined;
        request.mockImplementation(() => new Promise<UsageReport>((resolve) => { release = resolve; }));
        const screen = renderScreen();
        await tick();
        // The screen's one collection is in flight...
        expect(request).toHaveBeenCalledTimes(1);

        // ...and a pull lands on it. The spinner follows the read that is
        // running rather than retracting with no word at all.
        const pull = () => screen.root.findAllByType('ScrollView')[0].props.refreshControl.props;
        TestRenderer.act(() => { pull().onRefresh(); });
        expect(pull().refreshing).toBe(true);
        expect(request).toHaveBeenCalledTimes(1);

        await TestRenderer.act(async () => { release(report('claude', 0)); });
        expect(pull().refreshing).toBe(false);
    });
});
