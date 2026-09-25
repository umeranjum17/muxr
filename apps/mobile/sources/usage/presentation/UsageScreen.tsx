import * as React from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Header } from '@/components/navigation/Header';
import { HeaderBackButton } from '@/components/navigation/HeaderBackButton';
import { Ionicons } from '@expo/vector-icons';
import type { UsageReport } from '@muxr/contract';
import { PLUGIN_CALL_CLIENT_TIMEOUT_MS, type PluginScreenChartNode, type PluginScreenLimitsNode } from '@muxr/contract';
import { sync } from '@/catalog/sync';
import { hapticsSelection } from '@/components/haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { cardStyle, Notice, SectionLabel, withAlpha } from '@/components/ui';
import { Typography } from '@/constants/Typography';
import { AgentGlyph } from '@/components/AgentGlyph';
import { ScreenChart, ScreenLimits } from '@/plugins/ui';
import { t } from '@/text';
import { useForegroundRefresh } from '../application/useForegroundRefresh';
import { forcedReadWait } from '../application/forcedRead';
import { FRESH_MS, clearReportFailure, collectionDue, knownProviders, lastForcedRead, lastKnownPlan, noteAsked, noteForcedRead, noteReportFailure, noteTabListAsked, releaseAsked, rememberShown, reportFailure, shownUsage, subscribeUsage, tabListAskOwed, usageWrites, withReport, type UsageDisplay, type UsageFigures } from '../application/freshnessWindow';

/** The same primitives the declarative system renders, fed typed host data. */
const LIMITS_NODE: PluginScreenLimitsNode = { type: 'limits', path: 'limits', title: 'Right now' };
const LAST_KNOWN_NODE: PluginScreenLimitsNode = { type: 'limits', path: 'limits' };
const MODEL_CHART_NODE: PluginScreenChartNode = { type: 'chart', variant: 'bar', path: 'modelSeries', emptyText: 'No measured activity today' };
const WEEK_CHART_NODE: PluginScreenChartNode = { type: 'chart', variant: 'column', path: 'weekSeries', emptyText: 'No measured activity this week' };

/** What a tab shows before anything has been asked for it. A mount asks, so
 *  this is a wait, not an absence. */
const NOTHING_SHOWN_YET: UsageDisplay = { status: 'waiting', askedAt: 0 };

const DASH = '—';

/** The machine facts a display carries, when it carries them. */
function measured(source: { vitals?: UsageFigures['vitals'] }): { vitals?: UsageFigures['vitals'] } {
    return source.vitals === undefined ? {} : { vitals: source.vitals };
}

/**
 * The Usage screen: one tab per provider with real integration, its plan
 * limits, and its measured local activity. The host collects and normalizes;
 * this screen composes the system limits and chart primitives and owns the
 * wording. What there is to show comes from the same per-machine memory the
 * Home card reads, in one of three states -- figures, a wait, or a failure --
 * so a tab the card has just asked for shows its wait rather than nothing.
 */
export function UsageScreen() {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const router = useRouter();
    const routeParams = useLocalSearchParams<{ provider?: string }>();
    const requestedProvider = typeof routeParams.provider === 'string' ? routeParams.provider.slice(0, 32) : '';
    const [provider, setProvider] = React.useState(requestedProvider);
    React.useSyncExternalStore(subscribeUsage, usageWrites);
    const display = shownUsage(provider) ?? NOTHING_SHOWN_YET;
    const [refreshing, setRefreshing] = React.useState(false);
    // Any read in flight. It drives the hairline and the refresh control, never
    // the figures: what is on screen stays there until a newer answer lands.
    const [busy, setBusy] = React.useState(false);
    const [throttledSeconds, setThrottledSeconds] = React.useState<number>();
    const version = React.useRef(0);
    const inFlight = React.useRef(false);
    const rejected = React.useRef(false);
    const pendingRetry = React.useRef<string | undefined>(undefined);
    // The claim of the read in flight, for as long as its answer is
    // outstanding: a read abandoned before that has no answer coming.
    const claim = React.useRef<{ target: string; at: number } | undefined>(undefined);
    const error = display.status === 'unavailable' ? (display.reason === '' ? t('plugins.rightNow.unavailable') : display.reason) : undefined;
    const failure = reportFailure(provider);
    const failed = failure !== undefined;
    rejected.current = failed || display.status === 'unavailable';

    const report = display.status === 'figures' ? reportFrom(display.figures, provider) : undefined;
    const tabs = report?.providers ?? knownProviders();

    /**
     * Ask the host to collect this tab past its cache, and paint the answer.
     * This is the only kind of ask the screen sends: our own window decides
     * whether it happens at all, so a window costs one collection rather than a
     * cached read beside it. The read claims our window and the shared budget
     * at `claimedAtMs`, the instant the decision was taken, so the next window
     * is measured from where it decided rather than from a round trip.
     */
    const load = React.useCallback((target: string, claimedAtMs = Date.now()): Promise<void> => {
        const request = ++version.current;
        inFlight.current = true;
        setBusy(true);
        noteForcedRead(target, claimedAtMs);
        // This read supersedes whatever was in flight: that answer will be
        // dropped, so its claim goes with it now rather than a window later.
        const superseded = claim.current;
        if (superseded !== undefined) releaseAsked(superseded.target, superseded.at);
        noteAsked(target, claimedAtMs);
        claim.current = { target, at: claimedAtMs };
        const abandon = () => {
            releaseAsked(target, claimedAtMs);
            const held = claim.current;
            if (held !== undefined && held.target === target && held.at === claimedAtMs) claim.current = undefined;
        };
        // A tab already showing figures keeps them: this is a read running
        // behind an answer, not a reason to take that answer away.
        const before = shownUsage(target);
        if (before === undefined || before.status === 'waiting') rememberShown(target, { status: 'waiting', askedAt: claimedAtMs, ...measured(before ?? {}) });
        return sync.request('usage.report', { ...(target === '' ? {} : { provider: target }), refresh: true }, PLUGIN_CALL_CLIENT_TIMEOUT_MS)
            .then((value) => {
                if (request !== version.current) { abandon(); return; }
                claim.current = undefined;
                clearReportFailure(target);
                const previous = shownUsage(target);
                rememberShown(target, { status: 'figures', at: Date.now(), figures: withReport(previous?.status === 'figures' ? previous.figures : undefined, value) });
            })
            .catch((cause: unknown) => {
                if (request !== version.current) { abandon(); return; }
                claim.current = undefined;
                noteReportFailure(target, claimedAtMs, cause instanceof Error ? cause.message : String(cause));
                const previous = shownUsage(target);
                if (previous === undefined || previous.status !== 'figures') {
                    rememberShown(target, { status: 'unavailable', reason: cause instanceof Error ? cause.message : String(cause), ...measured(previous ?? {}) });
                }
            })
            .finally(() => {
                if (request !== version.current) { abandon(); return; }
                claim.current = undefined;
                inFlight.current = false;
                setBusy(false);
                setRefreshing(false);
                // A retry the person pressed runs the moment the read in flight
                // settles, rather than being swallowed by another tab's read.
                const pressed = pendingRetry.current;
                if (pressed === undefined) return;
                pendingRetry.current = undefined;
                setThrottledSeconds(undefined);
                void load(pressed);
            });
    }, []);

    /** A record only answers the questions it can answer: a card's usage.now
     *  figures name no tabs, so a screen holding only those asks once for the
     *  host's own list. Once per such record -- a record written after the last
     *  ask is one nobody has asked about yet -- and the ask itself claims the
     *  window, so the window governs every ask after it. */
    const unaskedTabList = React.useCallback((target: string): boolean => {
        const stored = shownUsage(target);
        if (stored === undefined || stored.status !== 'figures' || stored.figures.providers !== undefined) return false;
        return tabListAskOwed(target, stored.at);
    }, []);

    /** One ask for a tab, or none. Our own window decides, except for a record
     *  nobody has asked about that cannot answer this screen's question. A tab
     *  showing a wait or a failure is not asked for again: what it holds is the
     *  truth about it. `replace` lets a tab change through while another read
     *  is in flight. */
    const loadIfDue = React.useCallback((target: string, replace = false): void => {
        if (inFlight.current && !replace) return;
        const now = Date.now();
        const owed = unaskedTabList(target);
        if (!collectionDue(target, now) && !owed) return;
        if (owed) noteTabListAsked(target, now);
        void load(target, now);
    }, [load, unaskedTabList]);

    React.useEffect(() => {
        loadIfDue(provider, true);
    }, [provider, loadIfDue]);

    // A record that lands while this screen is open is answered the moment it
    // arrives: the store is the trigger, not the next foreground or tick.
    React.useEffect(() => {
        loadIfDue(provider);
    }, [display, provider, loadIfDue]);

    // A read still running when the screen goes cannot paint into it, and its
    // claim goes with it: no answer is coming for it.
    React.useEffect(() => () => {
        version.current += 1;
        const held = claim.current;
        claim.current = undefined;
        if (held !== undefined) releaseAsked(held.target, held.at);
    }, []);

    // Refreshing while focused and in the foreground only, and never on top of
    // a read that is already running -- opening the screen must not queue a
    // second ask behind the first.
    useForegroundRefresh(() => { loadIfDue(provider); }, FRESH_MS);

    // A pressed tab paints its own state at once; another tab's figures are not
    // this one's, and a tab showing a wait says so.
    const selectTab = (id: string) => {
        hapticsSelection();
        setProvider(id);
    };
    // The header control and the pull gesture are the same instruction: ask
    // past the cache, now. The budget refuses when a collection has just run;
    // a refusal is named at the control that was pressed, never silent.
    const askNow = (): boolean => {
        if (inFlight.current) return false;
        const waitSeconds = forcedReadWait(lastForcedRead(provider), rejected.current, Date.now());
        if (waitSeconds !== undefined) { setThrottledSeconds(waitSeconds); return false; }
        setThrottledSeconds(undefined);
        return true;
    };
    const onRefresh = () => {
        // A pull while a read is already running shows that read: the spinner
        // reflects work that is happening rather than a gesture that did
        // nothing. The read in flight clears it when it settles.
        if (inFlight.current) { setRefreshing(true); return; }
        if (!askNow()) return;
        setRefreshing(true);
        void load(provider);
    };
    // A pressed retry is an instruction: it runs, or it waits for the read in
    // flight and then runs, and a refusal is named at the control.
    const refreshNow = () => {
        hapticsSelection();
        if (inFlight.current) { pendingRetry.current = provider; return; }
        if (!askNow()) return;
        void load(provider);
    };

    React.useEffect(() => {
        if (throttledSeconds === undefined) return;
        const timer = setTimeout(() => setThrottledSeconds(undefined), throttledSeconds * 1_000);
        return () => clearTimeout(timer);
    }, [throttledSeconds]);

    // Only a report the host itself wrote as empty carries its words for that;
    // figures synthesized from a usage.now payload have no provider list at all
    // and must paint the limits they do hold rather than nothing.
    const empty = report !== undefined && report.providers.length === 0
        && (report.noProviders !== undefined || report.noProvidersTitle !== undefined);
    // Whether any usage.report read has answered for this tab's measured
    // activity. A usage.now record -- the card's -- carries limits only, so its
    // silence about activity is "not answered yet" (or, with a refused read,
    // "could not be read"), never "nothing measured": the three are different
    // facts and this screen is where they must not look alike.
    const activityUnread = display.status === 'figures' && display.figures.activity === undefined;
    const failureText = failure === undefined ? undefined
        : `${t('plugins.rightNow.refreshFailed')}: ${failure.reason} · ${new Date(failure.at).toLocaleTimeString()} · Retry available now`;
    // A tab whose own read has never answered still speaks for the limits the
    // reader already saw -- the card's connected strip carries them -- instead
    // of a refusal that reads as nothing.
    const lastKnown = display.status === 'unavailable' ? lastKnownPlan(provider) : undefined;
    const lastKnownAge = lastKnown === undefined || lastKnown.ageSeconds === undefined ? undefined : ageWord(lastKnown.ageSeconds);
    return (
        <>
            <Header
                title={<Text style={{ fontSize: 16, color: theme.colors.header.tint, ...Typography.default('semiBold') }}>{t('usage.title')}</Text>}
                headerLeft={() => <HeaderBackButton onPress={() => router.back()} label={t('plugins.goBack')} />}
                headerRight={() => <RefreshControlButton busy={busy} throttledSeconds={throttledSeconds} failed={failed} onPress={refreshNow} />}
                headerLeftGlass={false}
                headerRightGlass={false}
                headerShadowVisible={false}
                headerTransparent
            />
            {/* The header above is a laid-out sibling of this list, not a
                floating one, so the safe area and the header's own height are
                already paid for. Adding them to the content again is what
                pushed the tabs a whole header down the screen. */}
            <ScrollView
                style={{ flex: 1, backgroundColor: theme.colors.surface }}
                contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
                refreshControl={<RefreshControl refreshing={refreshing} tintColor={theme.colors.textSecondary} onRefresh={onRefresh} />}
            >
            <View style={{ width: '100%', maxWidth: 720, alignSelf: 'center', padding: 14, paddingTop: 10 }}>
                {/* Every read shows here, so a refresh is visible without any
                    figure being replaced by a spinner. The rail keeps its
                    height when idle, so nothing below it moves. */}
                <LoadingHairline active={busy} />
                {/* The tab strip is the host's own tab list, so it stays while a
                    tab is only waiting or unavailable: a reader is never left
                    with no way back to the figures another tab holds. */}
                {tabs.length > 0 && <ProviderTabs tabs={tabs} active={report?.provider ?? provider} onSelect={selectTab} />}
                {display.status === 'unavailable' && <Pressable onPress={refreshNow} accessibilityRole="button" accessibilityLabel={`${failureText ?? error ?? t('plugins.rightNow.unavailable')}. ${t('plugins.retry')}`} style={{ marginBottom: 8, paddingVertical: 10 }}>
                    <Notice tone="danger" text={failureText ?? error ?? t('plugins.rightNow.unavailable')} style={{ marginBottom: 0 }} />
                    <Text style={{ color: theme.colors.textLink, fontSize: 13, marginTop: 4, marginLeft: 14 }}>{t('plugins.retry')}</Text>
                </Pressable>}
                {display.status === 'unavailable' && lastKnown !== undefined && <View style={{ marginBottom: 8 }}>
                    <ScreenLimits node={LAST_KNOWN_NODE} data={{ limits: { verdict: 'unknown' as const, plan: lastKnown.plan, windows: lastKnown.windows } }} />
                    {lastKnownAge !== undefined && <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: -4 }}>{lastKnownAge}</Text>}
                </View>}
                {display.status === 'waiting' && <WaitingSkeleton />}
                {display.status === 'figures' && (empty
                    ? <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                        {report?.noProvidersTitle !== undefined && <Text style={{ color: theme.colors.text, fontSize: 16, fontWeight: '600' }}>{report.noProvidersTitle}</Text>}
                        {report?.noProviders !== undefined && <Text style={{ color: theme.colors.textSecondary, fontSize: 14, marginTop: 4, textAlign: 'center' }}>{report.noProviders}</Text>}
                    </View>
                    : <>
                        {report !== undefined && (activityUnread
                            ? <View style={{ opacity: busy ? 0.55 : 1 }}>
                                <ScreenLimits node={LIMITS_NODE} data={report} />
                                {failed
                                    ? <Pressable onPress={refreshNow} accessibilityRole="button" accessibilityLabel={`${failureText ?? t('plugins.rightNow.refreshFailed')}. ${t('plugins.rightNow.refreshNow')}`} style={{ marginTop: 10, paddingVertical: 10 }}>
                                        <Notice tone="danger" text={failureText ?? t('plugins.rightNow.refreshFailed')} style={{ marginBottom: 0 }} />
                                    </Pressable>
                                    : <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 12 }}>{t('plugins.rightNow.collecting')}</Text>}
                            </View>
                            : <View style={{ opacity: busy ? 0.55 : 1 }}>
                            <ScreenLimits node={LIMITS_NODE} data={report} />
                            {failureText !== undefined && <Notice tone="danger" text={failureText} />}
                            <SectionLabel style={{ marginBottom: 10 }}>Today</SectionLabel>
                            <View style={[cardStyle(theme), { paddingHorizontal: 16, paddingVertical: 12, marginBottom: 14 }]}>
                                {report.activityNotice !== undefined && <Notice tone="warning" text={report.activityNotice} />}
                                <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 10 }}>
                                    <View style={{ flexBasis: '48%', flexGrow: 1 }}><Metric label="Tokens" value={report.todayTokens} /></View>
                                    <View style={{ flexBasis: '48%', flexGrow: 1 }}><Metric label="Cost" value={report.todayCost} /></View>
                                </View>
                            </View>
                            <SectionLabel style={{ marginBottom: 10 }}>Models today</SectionLabel>
                            <ScreenChart node={MODEL_CHART_NODE} data={report} nested={false} />
                            <SectionLabel style={{ marginBottom: 10 }}>Last 7 days</SectionLabel>
                            {/* The week's totals and its shape are one answer, so
                                the columns sit in the same card as the figures. */}
                            <View style={[cardStyle(theme), { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 14 }]}>
                                <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 10, marginBottom: 6 }}>
                                    <View style={{ flexBasis: '48%', flexGrow: 1 }}><Metric label="Tokens" value={report.weekTokens} /></View>
                                    <View style={{ flexBasis: '48%', flexGrow: 1 }}><Metric label="Cost" value={report.weekCost} /></View>
                                </View>
                                <ScreenChart node={WEEK_CHART_NODE} data={report} nested />
                            </View>
                            <Text style={{ color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 14 }}>
                                Local activity and estimated costs are separate from provider plan limits. Prompts and project details stay out.
                            </Text>
                            </View>)}
                    </>)}
            </View>
            </ScrollView>
        </>
    );
}

/** The figures the store holds as this screen can paint them: one projection,
 *  so the limits and plans a usage.now read painted are here beside the
 *  activity a usage.report read painted. Activity nobody has measured is a
 *  dash, which is what the host sends when a figure is not measured. */
function reportFrom(figures: UsageFigures, provider: string): UsageReport {
    const plans = figures.connected ?? [];
    const providers = figures.providers ?? plans.map((plan) => ({ id: plan.id, label: plan.label, glyph: plan.glyph ?? plan.id }));
    const activity = figures.activity;
    return {
        providers,
        // The tab the host answered for, so the default view marks its pill.
        provider: activity?.provider ?? provider,
        providerName: plans.find((plan) => plan.id === provider)?.label ?? provider,
        windowPeriods: [],
        windows: [],
        limits: { ...figures.limits, windows: figures.windows ?? figures.limits.windows },
        ...(figures.connected === undefined ? {} : { connected: figures.connected }),
        ...(figures.ageSeconds === undefined ? {} : { ageSeconds: figures.ageSeconds }),
        capturedAt: figures.capturedAt ?? new Date().toISOString(),
        todayTokens: activity?.todayTokens ?? DASH,
        todayCost: activity?.todayCost ?? DASH,
        modelSeries: activity?.modelSeries ?? [],
        weekTokens: activity?.weekTokens ?? DASH,
        weekCost: activity?.weekCost ?? DASH,
        weekSeries: activity?.weekSeries ?? [],
        ...(activity?.activityNotice === undefined ? {} : { activityNotice: activity.activityNotice }),
        ...(activity?.noProvidersTitle === undefined ? {} : { noProvidersTitle: activity.noProvidersTitle }),
        ...(activity?.noProviders === undefined ? {} : { noProviders: activity.noProviders }),
    };
}

/** The screen's explicit "now, past the cache" control. It dims while a read
 *  is running rather than swapping in a spinner, so the control keeps its
 *  place and the figures keep theirs. A refused tap is named here, beside the
 *  control that was pressed, so it cannot scroll away from it. */
function RefreshControlButton({ busy, throttledSeconds, failed, onPress }: { busy: boolean; throttledSeconds?: number; failed: boolean; onPress: () => void }) {
    const { theme } = useUnistyles();
    const throttled = throttledSeconds !== undefined;
    const word = throttled ? t('plugins.rightNow.refreshIn', { seconds: throttledSeconds }) : failed ? t('plugins.rightNow.refreshFailed') : undefined;
    const label = throttled
        ? `${t('plugins.rightNow.refreshThrottled', { seconds: throttledSeconds })}. ${t('plugins.rightNow.refreshNow')}`
        : failed ? `${t('plugins.rightNow.refreshFailed')}. ${t('plugins.rightNow.refreshNow')}` : t('plugins.rightNow.refreshNow');
    const alert = failed && !throttled;
    const tint = alert ? theme.colors.textDestructive : withAlpha(theme.colors.header.tint, busy ? 0.4 : 1);
    return (
        <Pressable onPress={onPress} disabled={busy} hitSlop={10} accessibilityRole="button"
            accessibilityState={{ busy }}
            accessibilityLabel={label}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 5, padding: 6, flexShrink: 1, maxWidth: 190 }}>
            <Ionicons name="refresh" size={20} color={tint} />
            {word !== undefined && <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 11.5, lineHeight: 15, ...Typography.mono('regular'), color: tint }}>
                {word}
            </Text>}
        </Pressable>
    );
}

/** The same pill strip the declarative tabs node draws: agent mark, short
 *  name, selected fill. A tab means a real integration, so the strip only
 *  lists providers the host measured or found connected. */
function ProviderTabs({ tabs, active, onSelect }: { tabs: UsageReport['providers']; active?: string; onSelect: (id: string) => void }) {
    const { theme } = useUnistyles();
    const strip = React.useRef<ScrollView>(null);
    const pills = React.useRef(new Map<string, { x: number; width: number }>());
    const view = React.useRef({ x: 0, width: 0 });
    // The selected pill is always on screen: a deep link or the default view
    // can select a provider past the edge, and a half-cut selection reads as
    // a layout bug. A pill already in view never moves the strip.
    const reveal = React.useCallback(() => {
        const pill = active === undefined ? undefined : pills.current.get(active);
        const { x, width } = view.current;
        if (pill === undefined || width === 0) return;
        if (pill.x - 14 < x) strip.current?.scrollTo({ x: Math.max(0, pill.x - 14), animated: true });
        else if (pill.x + pill.width + 14 > x + width) strip.current?.scrollTo({ x: pill.x + pill.width + 14 - width, animated: true });
    }, [active]);
    React.useEffect(reveal, [reveal]);
    if (tabs.length === 0) return null;
    return (
        // The strip runs to the screen edges, so a sixth provider scrolls in
        // from the edge instead of being cut at the page gutter.
        <ScrollView ref={strip} horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12, marginHorizontal: -14 }} contentContainerStyle={{ gap: 6, paddingHorizontal: 14 }}
            scrollEventThrottle={32}
            onScroll={(event) => { view.current.x = event.nativeEvent.contentOffset.x; }}
            onLayout={(event) => { view.current.width = event.nativeEvent.layout.width; reveal(); }}>
            {tabs.map((tab) => {
                const labelColor = tab.id === active ? theme.colors.surface : theme.colors.textSecondary;
                return (
                    <Pressable key={tab.id} accessibilityRole="tab" accessibilityState={{ selected: tab.id === active }} accessibilityLabel={tab.label}
                        onLayout={(event) => {
                            const { x, width } = event.nativeEvent.layout;
                            pills.current.set(tab.id, { x, width });
                            if (tab.id === active) reveal();
                        }}
                        onPress={() => onSelect(tab.id)}
                        style={({ pressed }) => ({
                            flexDirection: 'row', alignItems: 'center', gap: 6,
                            paddingLeft: 10, paddingRight: 12, paddingVertical: 7, borderRadius: 999,
                            borderWidth: StyleSheet.hairlineWidth,
                            borderColor: tab.id === active ? 'transparent' : theme.colors.divider,
                            backgroundColor: tab.id === active ? theme.colors.accent : pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh,
                        })}>
                        <AgentGlyph name={tab.glyph} size={16} color={labelColor} />
                        <Text style={{ fontSize: 13, fontWeight: '600', color: labelColor }}>{tab.label}</Text>
                    </Pressable>
                );
            })}
        </ScrollView>
    );
}

/** The age of the last-known figures, in the words every other surface uses. */
function ageWord(ageSeconds: number): string | undefined {
    const minutes = Math.round(ageSeconds / 60);
    if (minutes < 1) return undefined;
    if (minutes < 60) return t('time.minutesAgo', { count: minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 24) return t('time.hoursAgo', { count: hours });
    return t('time.daysAgo', { count: Math.round(hours / 24) });
}

/** Caption + one big mono figure; a missing figure is information, not a
 *  hole (the host sends a dash). */
function Metric({ label, value }: { label: string; value: string }) {
    const { theme } = useUnistyles();
    const blank = value === '' || value === DASH;
    return (
        <View style={{ paddingVertical: 10 }}>
            <Text style={{ color: withAlpha(theme.colors.textSecondary, 0.85), fontSize: 12, lineHeight: 16, fontWeight: '600', ...Typography.default('semiBold') }}>{label}</Text>
            <Text style={{ color: blank ? theme.colors.textSecondary : theme.colors.text, fontSize: 30, letterSpacing: -0.5, marginTop: 2, ...Typography.mono('semiBold') }}>{blank ? DASH : value}</Text>
        </View>
    );
}

/** A first read in flight, in the shape of the answer it is waiting for: the
 *  limits card, then today, then the models. The words say what is happening;
 *  the blocks keep the page from jumping when the figures land. */
function WaitingSkeleton() {
    const { theme } = useUnistyles();
    const block = { ...cardStyle(theme), marginBottom: 14, backgroundColor: withAlpha(theme.colors.surfaceHigh, 0.6) };
    return (
        <View>
            <View style={[block, { height: 220, alignItems: 'center', justifyContent: 'center' }]}>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 14, textAlign: 'center' }}>{t('plugins.rightNow.collecting')}</Text>
            </View>
            <View style={[block, { height: 96 }]} />
            <View style={[block, { height: 140 }]} />
        </View>
    );
}

/** Indeterminate 2px bar: says "working" without taking the content's place. */
function LoadingHairline({ active }: { active: boolean }) {
    const { theme } = useUnistyles();
    if (!active) return <View style={{ height: 2, marginBottom: 8 }} />;
    return (
        <View style={{ height: 2, marginBottom: 8, borderRadius: 1, overflow: 'hidden', backgroundColor: withAlpha(theme.colors.accent, 0.16) }}>
            <View style={{ height: 2, width: '35%', borderRadius: 1, backgroundColor: withAlpha(theme.colors.accent, 0.5) }} />
        </View>
    );
}
