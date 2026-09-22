import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import type { UsageNow, UsageReport } from '@muxr/contract';

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
vi.mock('@/plugins', () => ({ toneColor: () => '#000' }));
vi.mock('@/plugins/ui', () => ({
    ScreenChart: 'ScreenChart',
    ScreenLimits: 'ScreenLimits',
    VERDICT_KEYS: { limited: 'plugins.limits.limited' },
    verdictTone: () => undefined,
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));

const { useUsageNow } = await import('./useUsageNow');
const { RightNowCard } = await import('../presentation/RightNowCard');
const { UsageScreen } = await import('../presentation/UsageScreen');

const FRESH_MS = 15 * 60_000;
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

function renderScreen() {
    let renderer: any;
    TestRenderer.act(() => { renderer = TestRenderer.create(<UsageScreen />); });
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
beforeEach(() => {
    vi.useFakeTimers();
    // The per-tab window outlives a screen and a test, so each one starts a day
    // on: a previous test's ask cannot close this one's window.
    testEpoch += 24 * 60 * 60_000;
    vi.setSystemTime(testEpoch);
    request.mockReset();
    hapticsSelection.mockClear();
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
        // a reader can see are old are revalidated at once rather than served
        // again -- and the cadence keeps asking past the cache while they stay
        // old.
        request.mockResolvedValue(collected(FRESH_MS / 1_000 + 60));
        mount();

        await tick();
        expect(forcedReads()).toHaveLength(1);

        await tick(FRESH_MS);
        expect(forcedReads().length).toBeGreaterThanOrEqual(2);
    });

    it('paints a stale first payload at once and revalidates it once behind the figures', async () => {
        let release: (value: UsageNow) => void = () => undefined;
        request.mockResolvedValueOnce(collected(FRESH_MS / 1_000 + 60, 100))
            .mockImplementationOnce(() => new Promise<UsageNow>((resolve) => { release = resolve; }))
            .mockResolvedValue(collected(undefined, 20));
        const card = renderCard();
        await tick();

        // The old figures paint immediately -- what is already on disk is not
        // withheld while a collection runs -- with the read visible in the
        // control rather than where the figures are.
        expect(screenText(card)).toContain('0%');
        expect(screenText(card)).toContain('plugins.rightNow.refreshing');
        expect(forcedReads()).toHaveLength(1);

        // The newer answer swaps in place, and the automatic revalidation does
        // not chain into a second forced read.
        await TestRenderer.act(async () => { release(collected(undefined, 20)); });
        expect(screenText(card)).toContain('80%');
        await tick(60_000);
        expect(forcedReads()).toHaveLength(1);
    });

    it('revalidates a stale first read exactly once, however old the answer stays', async () => {
        // The host keeps reporting the same old capture: the one automatic
        // revalidation must not start another.
        request.mockResolvedValue(collected(FRESH_MS / 1_000 + 60));
        mount();

        await tick();
        expect(forcedReads()).toHaveLength(1);

        await tick(60_000);
        expect(forcedReads()).toHaveLength(1);
    });

    it('does not revalidate a first read that is still inside its window', async () => {
        request.mockResolvedValue(collected(60));
        mount();

        await tick();
        await tick(60_000);
        expect(forcedReads()).toHaveLength(0);
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
        request.mockResolvedValueOnce(collected(3)).mockResolvedValueOnce(COLLECTING).mockResolvedValueOnce(collected(8)).mockResolvedValue(collected(1));
        const card = mount();
        await tick();

        TestRenderer.act(() => { card.latest().refresh(); });
        await tick();
        expect(card.latest().refreshing).toBe(true);

        await tick(6_000);
        expect(card.latest().value?.ageSeconds).toBe(3);
        expect(card.latest().refreshing).toBe(true);

        await tick(6_000);
        expect(card.latest().value?.ageSeconds).toBe(1);
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

        TestRenderer.act(() => { card.latest().refresh(); });
        await tick();
        expect(card.latest().refreshing).toBe(true);

        await tick(6_000);
        expect(card.latest().value?.capturedAt).toBe(capture);
        expect(card.latest().refreshing).toBe(true);

        await tick(6_000);
        expect(card.latest().value?.capturedAt).toBe('2026-09-22T10:20:00.000Z');
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

    it('does not add a collection from a cycle landing on a read in flight', async () => {
        let release: (value: UsageNow) => void = () => undefined;
        request.mockResolvedValueOnce(collected(FRESH_MS / 1_000 + 60))
            .mockImplementationOnce(() => new Promise<UsageNow>((resolve) => { release = resolve; }))
            .mockResolvedValue(collected());
        const card = mount();
        await tick();

        // The old readings start their one revalidation and keep it in
        // flight...
        await tick(11_000);
        // ...when a cycle lands. It cannot ask behind it, so no second read is
        // issued and no budget claimed.
        TestRenderer.act(() => { appState.currentState = 'active'; appState.listeners.forEach((listener) => listener('active')); });
        await TestRenderer.act(async () => { release(collected()); });

        // The tap after it is still honoured.
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
        request.mockResolvedValueOnce(collected()).mockRejectedValueOnce(new Error('host unreachable')).mockResolvedValue(collected());
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

describe('the usage screen read path', () => {
    it('names a refused tap at the control that was pressed', async () => {
        request.mockResolvedValue(report('claude', 1_200));
        const screen = renderScreen();
        await tick();
        // The old readings revalidated once, spending the forced-read budget.
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

    it('collects at most once across opening, re-entry, foreground and a tab switch', async () => {
        // The phone arrives on figures twenty minutes old; every later read
        // inside the window is served a same-day entry the host still marks
        // stale at sixty seconds.
        const cachedAt: Record<string, number> = { claude: Date.now() - 20 * 60_000, opencode: Date.now() - 90_000 };
        request.mockImplementation((_method: string, params?: { provider?: string; refresh?: boolean }) => {
            const tab = params?.provider ?? 'claude';
            if (params?.refresh === true) cachedAt[tab] = Date.now();
            return Promise.resolve(report(tab, Math.max(0, Math.round((Date.now() - cachedAt[tab]) / 1_000))));
        });

        // Opening on readings past the window is worth one collection.
        let screen = renderScreen();
        await tick();
        expect(forcedReads()).toHaveLength(1);

        // Re-entry...
        await tick(90_000);
        TestRenderer.act(() => { screen.unmount(); });
        screen = renderScreen();
        await tick();
        // ...a return from the background...
        await tick(90_000);
        TestRenderer.act(() => { appState.currentState = 'active'; appState.listeners.forEach((listener) => listener('active')); });
        await tick();
        // ...and a tab switch, all inside the same window.
        await tick(90_000);
        press(screen, 'OpenCode');
        await tick();

        expect(forcedReads()).toHaveLength(1);
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
});
