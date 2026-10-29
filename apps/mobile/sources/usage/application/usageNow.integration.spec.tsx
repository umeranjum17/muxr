import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import type { AgentLifecycle, HerdrTreeWorkspace, UsageActivityDay, UsageNow, UsageReport } from '@trymuxr/contract';
import { FRESH_MS, noteAsked, rememberShown, withNow, withReport } from './freshnessWindow';

/**
 * Real usage hooks, freshness state and components across the retained card,
 * refresh, plan and report journeys. RPC, clock and native views are boundary
 * fixtures; these checks do not prove native layout. The per-branch cache and
 * formatter matrix is deliberately absent.
 */

const request = vi.fn();
const connection = { machineId: 'machine-1' };
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
    useWindowDimensions: () => ({ width: 393, height: 852, scale: 3, fontScale: 1 }),
    View: 'View',
}));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme }) }));
vi.mock('react-native-reanimated', () => ({
    default: { View: 'Animated.View' },
    Easing: { bezier: () => undefined, inOut: () => undefined, quad: undefined },
    useAnimatedStyle: () => ({}),
    useReducedMotion: () => true,
    useSharedValue: (value: unknown) => ({ value }),
    withDelay: (_delay: number, value: unknown) => value,
    withTiming: (value: unknown) => value,
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@/components/haptics', () => ({ hapticsSelection: () => undefined }));
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
vi.mock('../presentation/ScreenCharts', () => ({ ScreenChart: 'ScreenChart' }));
// Keys stand in for words; a share keeps its figure, as every real string does,
// and a sentence keeps what it was given to say.
vi.mock('@/text', () => ({
    getCurrentLanguageTag: () => 'en',
    t: (key: string, params?: Record<string, unknown>) => (params === undefined ? key
        : params.percent !== undefined ? `${params.percent}% ${key}`
            : `${key}(${Object.values(params).join(' | ')})`),
}));

const { useUsageNow } = await import('./useUsageNow');
const { RightNowCard } = await import('../presentation/RightNowCard');
const { UsageScreen } = await import('../presentation/UsageScreen');
// The herd's own derivation, not a stand-in: Home's sentence comes from these.
const { agentSummary, agentSummaryLine, herdPanes } = await import('@/herd/model');
const { selectLiveTerminalCards } = await import('@/herd/live');

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
    TestRenderer.act(() => { mounted.push(TestRenderer.create(<Probe />)); });
    return { seen, latest: () => seen[seen.length - 1]! };
}

/** Everything a test renders, so a surface it left mounted cannot react to the
 *  next test's store write. */
const mounted: any[] = [];

function renderCard(props: { agentLine?: string } = {}) {
    let renderer: any;
    TestRenderer.act(() => { renderer = TestRenderer.create(<RightNowCard {...props} />); });
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

/** Like screenText, but a Text's string array children join in, and runs of
 *  space collapse -- so a sentence its label and figure share reads as one. */
const flatText = (renderer: any): string => renderer.root.findAllByType('Text')
    .map((node: any) => Array.isArray(node.props.children)
        ? node.props.children.filter((child: any) => typeof child === 'string').join('')
        : node.props.children)
    .filter((text: any) => typeof text === 'string').join(' ')
    .replace(/\s+/g, ' ');

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
    appState.currentState = 'active';
    appState.listeners.clear();
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



    it('keeps old figures visibly stale after a failed refresh, then clears the failure on a fresh answer', async () => {
        request.mockResolvedValueOnce(collected(90)).mockRejectedValueOnce(new Error('host unreachable')).mockResolvedValue(collected());
        const card = renderCard();
        await tick();
        await tick(11_000);

        pressRefresh(card);
        await tick(1_000);
        expect(screenText(card)).toContain('plugins.rightNow.refreshFailed');
        expect(screenText(card)).toContain('components.sessionStatusBar.limitAsOf');
        expect(screenText(card)).not.toContain('plugins.rightNow.refreshing');
        expect(screenText(card)).toContain('5h 0%');

        await tick(30_000);
        expect(forcedReads()).toHaveLength(3);
        expect(screenText(card)).not.toContain('plugins.rightNow.refreshFailed');

        // After a host restart its retained cache can answer first while it
        // collects. A final answer naming the SAME reading is not progress:
        // finish as a failed refresh instead of polling a finished collection.
        const capturedAt = new Date(Date.now() - 90_000).toISOString();
        request.mockResolvedValueOnce({ ...collected(90, 100, capturedAt), refreshing: true })
            .mockResolvedValue(collected(96, 100, capturedAt));
        await tick(11_000);
        pressRefresh(card);
        await tick();
        expect(screenText(card)).toContain('plugins.rightNow.refreshing');
        await tick(6_000);
        expect(screenText(card)).not.toContain('plugins.rightNow.refreshing');
        expect(screenText(card)).toContain('plugins.rightNow.refreshFailed');
        expect(screenText(card)).toContain('5h 0%');
    });


});

describe('the usage screen read path', () => {


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
            ['7d', '#999'], ['36% plugins.limits.percentLeft', '#fff'],
            ['5h×2', '#999'], ['60% plugins.limits.percentLeft', '#fff'], ['7d', '#999'], ['89% plugins.limits.percentLeft', '#fff'],
            ['5h', '#999'], ['93% plugins.limits.percentLeft', '#fff'], ['7d', '#999'], ['0% plugins.limits.percentLeft', '#f55'], ['Month', '#999'], ['8% plugins.limits.percentLeft', '#fa0'],
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
        const codexTags = codexText().filter((text) => !text.includes('%'));
        expect(codexTags).toContain('gpt-4');
        expect(codexTags).toContain('gpt-5');
        expect(screenText(card)).toContain('Month');
        expect(new Set(codexTags).size).toBe(codexTags.length);
        expect(codexTags.every((tag) => tag.length <= 6)).toBe(true);
        const namedShares = () => Object.fromEntries(codexText().filter((_, index) => index % 2 === 0)
            .map((tag, index) => [tag, codexText()[index * 2 + 1]]));
        expect(namedShares()).toMatchObject({ turbo: '48% plugins.limits.percentLeft', vision: '29% plugins.limits.percentLeft', Spark: '35% plugins.limits.percentLeft', Mini: '24% plugins.limits.percentLeft' });
        TestRenderer.act(() => { rememberShown('', { status: 'figures', at: Date.now() + 2, figures: withNow(undefined, {
            ...namedNow,
            connected: namedNow.connected!.map((provider) => provider.id === 'codex'
                ? { ...provider, windows: [...provider.windows].reverse() }
                : provider),
        }) }); });
        expect(namedShares()).toMatchObject({ turbo: '48% plugins.limits.percentLeft', vision: '29% plugins.limits.percentLeft', Spark: '35% plugins.limits.percentLeft', Mini: '24% plugins.limits.percentLeft' });
        expect(figures()).toContainEqual(['83% plugins.limits.percentLeft', '#fff']);
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



    it('shows each route\'s cost for the span shown, marking a floor, and nothing for a route that could not be priced', async () => {
        // The figure beside a route's tokens belongs to the span on screen, a
        // cost the harness could not fully price reads as the floor it is,
        // and a route with no recorded cost stays silent rather than reading
        // as free.
        request.mockResolvedValue({
            ...report('pi', 0),
            activity: {
                state: 'measured' as const,
                hourly: [],
                days: ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07']
                    .map((date, index) => ({ date, input: index === 6 ? 4_000_000 : 0, output: 0, cacheRead: 0, cacheWrite: 0, other: 0 })),
                models: [],
                routes: [
                    { id: 'openai-codex', label: 'OpenAI Codex', glyph: 'codex', today: 4_000_000, week: 21_100_000_000, month: 30_000_000_000, weekCost: 950, monthCost: 1_900 },
                    { id: 'anthropic', label: 'Anthropic', glyph: 'claude', today: 0, week: 2_000_000, month: 2_000_000, weekCost: 40, monthCost: 40, weekUnpriced: true, monthUnpriced: true },
                    { id: 'google', label: 'Gemini', glyph: 'gemini', today: 0, week: 5_000_000, month: 5_000_000 },
                ],
            },
        });
        const routeRow = (label: string): string => {
            const row = screen.root.findAll((node: any) => typeof node.props?.accessibilityLabel === 'string' && node.props.accessibilityLabel.startsWith(`${label}:`))[0];
            if (row === undefined) throw new Error(`no route row for ${label}`);
            return row.props.accessibilityLabel;
        };
        const screen = renderScreen();
        await tick();
        expect(routeRow('OpenAI Codex')).toBe('OpenAI Codex: 21.1B tokens, $950, 100 percent');
        expect(routeRow('Anthropic')).toBe('Anthropic: 2M tokens, ≥ $40.00, 0 percent');
        expect(routeRow('Gemini')).toBe('Gemini: 5M tokens, 0 percent');
        expect(screenText(screen)).toContain('· $950');
        expect(screenText(screen)).toContain('≥ $40.00');

        // The month span carries the month's own cost, never the week's.
        press(screen, '30 days');
        await tick();
        expect(routeRow('OpenAI Codex')).toBe('OpenAI Codex: 30B tokens, $1,900, 100 percent');
        expect(routeRow('Anthropic')).toBe('Anthropic: 2M tokens, ≥ $40.00, 0 percent');
        expect(routeRow('Gemini')).toBe('Gemini: 5M tokens, 0 percent');

        // A route with no recorded cost earns no dollar figure on either span.
        expect(screenText(screen)).not.toContain('$0');
    });

    it('speaks no dollar figure on a plan-priced tab, whose footnote stays the one explanation', async () => {
        // The Z.ai tab's costs are withheld because its plan prices the
        // traffic: its cards show tokens alone -- neither '$' nor 'Not priced'
        // -- while a tab whose costs are genuinely unknown still says so.
        const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07']
            .map((date, index) => ({ date, input: index === 6 ? 4_000_000 : 900_000, output: 0, cacheRead: 0, cacheWrite: 0, other: 0 }));
        request.mockResolvedValue({
            ...report('zai', 0),
            providers: [{ id: 'zai', label: 'Z.ai', glyph: 'zai' }],
            providerName: 'Z.ai',
            activity: { state: 'measured' as const, hourly: [100, 200], days, models: [] },
        });
        const screen = renderScreen();
        await tick();
        expect(flatText(screen)).toContain('Plan traffic is priced by the plan, so no dollar figure is shown.');
        expect(flatText(screen)).not.toContain('Not priced');
        expect(flatText(screen)).not.toContain('$');
        expect(flatText(screen)).not.toContain('Cost');
        const today = screen.root.findAll((node: any) => node.props?.accessibilityRole === 'summary')[0];
        expect(today.props.accessibilityLabel).toContain('Today 4M tokens');
        expect(today.props.accessibilityLabel).not.toContain('Not priced');

        // The same cards keep the honest label where cost is genuinely
        // unknown: another machine's tab, whose retained window this test's
        // first read does not hold open.
        connection.machineId = 'machine-plan-unknown';
        request.mockResolvedValue({
            ...report('pi', 0),
            activity: { state: 'measured' as const, hourly: [100, 200], days: days.map((day) => ({ ...day, unpriced: true as const })), models: [] },
        });
        const other = renderScreen();
        await tick();
        expect(flatText(other)).toContain('Not priced');
        expect(flatText(other)).toContain('Cost');
    });

    it('opens each tab on its own span, so a tab idle this week is not shown the busy tab\'s empty week', async () => {
        // Claude worked today; OpenCode last worked a fortnight ago. The span
        // picked on one tab used to carry to the next, so OpenCode read as
        // zero until its month was tapped.
        const days = (busyToday: boolean) => Array.from({ length: 30 }, (_, index) => ({
            date: `2026-08-${String(index + 1).padStart(2, '0')}`,
            input: (busyToday ? index === 29 : index === 14) ? 5_000_000 : 0,
            output: 0, cacheRead: 0, cacheWrite: 0, other: 0,
        }));
        request.mockImplementation((_method: string, params?: { provider?: string }) => {
            const provider = params?.provider ?? 'claude';
            return Promise.resolve({ ...report(provider, 0), activity: { state: 'measured' as const, hourly: [], days: days(provider === 'claude'), models: [] } });
        });
        const screen = renderScreen();
        await tick();
        const selectedSpan = () => screen.root.findAll((node: any) => node.props?.accessibilityRole === 'tab'
            && node.props?.accessibilityState?.selected === true
            && /^\d+ days$/.test(node.props?.accessibilityLabel ?? ''))[0]?.props.accessibilityLabel;

        expect(selectedSpan()).toBe('7 days');
        press(screen, 'OpenCode');
        await tick();
        expect(selectedSpan()).toBe('30 days');
        expect(flatText(screen)).toContain('5M');

        // A pick stays with its tab: the week chosen here is not Claude's.
        press(screen, '7 days');
        press(screen, 'Claude');
        await tick();
        press(screen, '30 days');
        press(screen, 'OpenCode');
        await tick();
        expect(selectedSpan()).toBe('30 days');
        press(screen, 'Claude');
        await tick();
        expect(selectedSpan()).toBe('7 days');
    });

    it('names the day\'s unitemized tokens Other in the split, and only while there are any', async () => {
        // A kimi-style day: the source counted 60K and itemized 40K by model.
        // The 20K rest is its own kind in the legend -- not folded into Input
        // -- and stays only while there is any of it.
        const day = (other: number): UsageActivityDay => ({ date: '2026-09-07', input: 40_000, output: 0, cacheRead: 0, cacheWrite: 0, other });
        const kimi = (days: UsageActivityDay[]) => ({
            ...report('kimi', 0),
            providers: [{ id: 'kimi', label: 'Kimi', glyph: 'kimi' }],
            providerName: 'Kimi',
            activity: { state: 'measured' as const, hourly: [], days, models: [] },
        });
        request.mockResolvedValue(kimi([day(20_000)]));
        const screen = renderScreen();
        await tick();
        expect(flatText(screen)).toContain('Input 40K');
        expect(flatText(screen)).toContain('Other 20K');

        connection.machineId = 'machine-split-itemized';
        request.mockResolvedValue(kimi([day(0)]));
        const plain = renderScreen();
        await tick();
        expect(flatText(plain)).toContain('Input 40K');
        expect(flatText(plain)).not.toContain('Other');
    });
});

/**
 * What the herd is doing, said on the card itself.
 *
 * The card used to end with the machine's own state as one word -- Healthy, or
 * Busy -- and Busy named the computer's memory and load while reading as the
 * agent's. A person could not tell whether work was going on, whether anything
 * waited for them, or whether an agent had stopped, so they opened the app to
 * find out. These are the four states they meet, driven from a Herdr tree the
 * way Home gets one, and the sentence each one earns.
 */
describe('the herd, said on the Home card', () => {
    /** One workspace holding the given agents, as Herdr publishes it. */
    const herd = (agents: { status: AgentLifecycle }[]): HerdrTreeWorkspace[] => [{
        workspaceId: 'home', focused: true, agentStatus: 'idle',
        tabs: [{
            tabId: 'home-tab', focused: true, agentStatus: 'idle',
            panes: agents.map((agent, index) => ({
                paneId: `pane-${index}`, tabId: 'home-tab', sessionId: `agent-${index}`,
                focused: index === 0, agentStatus: agent.status, promptable: true, agentKind: 'pi',
            })),
        }],
    }];

    /** The one state Home's own derivation reaches from that tree. */
    const summaryOf = (agents: { status: AgentLifecycle }[]) => {
        const workspaces = herd(agents);
        const sessions = workspaces[0]!.tabs[0]!.panes
            .map((pane) => ({ id: pane.sessionId!, updatedAt: 0, metadata: null, presence: 'online' as const }));
        return agentSummary(selectLiveTerminalCards(sessions, herdPanes(sessions, workspaces)));
    };

    it('says what is happening in a sentence, in every state a person meets', async () => {
        request.mockResolvedValue(collected());
        const cases: [{ status: AgentLifecycle }[], string, string][] = [
            [[{ status: 'working' }], 'working', 'plugins.rightNow.herdWorking'],
            [[{ status: 'blocked' }], 'waiting', 'plugins.rightNow.herdWaiting'],
            [[{ status: 'failed' }], 'stopped', 'plugins.rightNow.herdStopped'],
            [[{ status: 'idle' }], 'ready', 'plugins.rightNow.herdReady'],
            [[], 'none', 'plugins.rightNow.herdNone'],
            // One agent waiting outranks one that is only at work.
            [[{ status: 'working' }, { status: 'blocked' }], 'waiting', 'plugins.rightNow.herdWaiting'],
        ];
        for (const [agents, state, line] of cases) {
            expect(summaryOf(agents)).toBe(state);
            const card = renderCard({ agentLine: agentSummaryLine(summaryOf(agents)) });
            await tick();
            expect(flatText(card)).toContain(line);
            // The words are spoken too: a reader on a screen reader hears the
            // same answer on the strip's own control.
            const strip = card.root.findAll((node: any) => node.props?.accessibilityRole === 'button'
                && node.props?.onLongPress !== undefined)[0];
            expect(strip.props.accessibilityLabel).toContain(line);
        }
    });
});
