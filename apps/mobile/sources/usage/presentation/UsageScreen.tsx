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
import { FRESH_MS, collectionDue, noteAsked } from '../application/freshnessWindow';

/** Screen payloads survive a close: reopening renders at once, then refreshes. */
const reportCache = new Map<string, UsageReport>();
const MAX_CACHED_REPORTS = 16;

/** The same primitives the declarative system renders, fed typed host data. */
const LIMITS_NODE: PluginScreenLimitsNode = { type: 'limits', path: 'limits', title: 'Right now' };
const MODEL_CHART_NODE: PluginScreenChartNode = { type: 'chart', variant: 'bar', path: 'modelSeries', emptyText: 'No measured activity today' };
const WEEK_CHART_NODE: PluginScreenChartNode = { type: 'chart', variant: 'column', path: 'weekSeries', emptyText: 'No measured activity this week' };

/**
 * The Usage screen: one tab per provider with real integration, its plan
 * limits, and its measured local activity. The host collects and normalizes;
 * this screen composes the system limits and chart primitives and owns the
 * wording.
 */
export function UsageScreen() {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const router = useRouter();
    const routeParams = useLocalSearchParams<{ provider?: string }>();
    const requestedProvider = typeof routeParams.provider === 'string' ? routeParams.provider.slice(0, 32) : '';
    const [provider, setProvider] = React.useState(requestedProvider);
    const [fetched, setFetched] = React.useState<{ key: string; value?: UsageReport }>(() => ({ key: provider, value: reportCache.get(provider) }));
    const [error, setError] = React.useState<string>();
    const [refreshing, setRefreshing] = React.useState(false);
    const [loading, setLoading] = React.useState(!reportCache.has(provider));
    // Any read in flight, including the quiet ones. It drives the hairline and
    // the refresh control, never the figures: what is on screen stays there
    // until a newer answer lands.
    const [busy, setBusy] = React.useState(false);
    const [throttledSeconds, setThrottledSeconds] = React.useState<number>();
    const version = React.useRef(0);
    const inFlight = React.useRef(false);
    const lastForced = React.useRef(0);
    const rejected = React.useRef(false);
    rejected.current = error !== undefined;

    const report = fetched.key === provider ? fetched.value : reportCache.get(provider);
    const tabs = report?.providers ?? [];

    /** The tab a collection our own window authorized was authorized for, and
     *  the instant it was decided: the report the host already holds paints
     *  first and this runs behind it, so nothing is ever withheld to decide
     *  whether to refresh it. Every forced read on this screen goes through the
     *  one budget in `forcedReadWait`, whether a person asked or a cadence
     *  cycle did. */
    const collectAfter = React.useRef<{ target: string; at: number } | undefined>(undefined);

    /**
     * `refresh` asks the host to collect past its cache; such a read claims our
     * own window and the shared budget at `claimedAtMs`, the instant the
     * decision to collect was taken, so the next window is measured from where
     * it decided rather than from a round trip. Every other ask is
     * cache-respecting, so what the host already holds paints at once. `quiet`
     * is the background cadence: it repaints without dimming figures that are
     * still the answer until a newer one lands.
     */
    const load = React.useCallback((target: string, refresh = false, quiet = false, claimedAtMs = Date.now()): Promise<void> => {
        const request = ++version.current;
        inFlight.current = true;
        setBusy(true);
        if (!refresh && !quiet) setLoading(true);
        setError(undefined);
        if (refresh) { lastForced.current = claimedAtMs; noteAsked(target, claimedAtMs); }
        return sync.request('usage.report', { ...(target === '' ? {} : { provider: target }), ...(refresh ? { refresh: true } : {}) }, PLUGIN_CALL_CLIENT_TIMEOUT_MS)
            .then((value) => {
                if (request !== version.current) return;
                reportCache.set(target, value);
                while (reportCache.size > MAX_CACHED_REPORTS) reportCache.delete(reportCache.keys().next().value!);
                setFetched({ key: target, value });
            })
            .catch((cause: unknown) => {
                if (request !== version.current) return;
                setError(cause instanceof Error ? cause.message : String(cause));
            })
            .finally(() => {
                if (request !== version.current) return;
                inFlight.current = false;
                setBusy(false);
                setLoading(false);
                setRefreshing(false);
                // The report the host already held has painted, so the one
                // collection our own window authorized runs behind it -- for the
                // tab that window belonged to, and no other.
                const owed = collectAfter.current;
                if (owed === undefined) return;
                collectAfter.current = undefined;
                if (owed.target !== target) return;
                if (forcedReadWait(lastForced.current, rejected.current, Date.now()) !== undefined) return;
                void load(target, true, true, owed.at);
            });
    }, []);

    /** One ask for a tab. It always paints what the host already holds; whether
     *  a collection runs behind that report is our own decision, taken and
     *  recorded at the instant we ask: a tab nobody has asked collects on its
     *  first view, and the host's word on how old its figures are is what the
     *  screen says about them rather than what decides this. `replace` lets a
     *  tab change through while another tab's read is still in flight; a
     *  cadence never stacks a second read behind one. */
    const loadIfDue = React.useCallback((target: string, quiet: boolean, replace = false): void => {
        if (inFlight.current && !replace) return;
        const now = Date.now();
        if (collectionDue(target, now)) collectAfter.current = { target, at: now };
        void load(target, false, quiet);
    }, [load]);

    React.useEffect(() => {
        loadIfDue(provider, false, true);
        return () => { version.current += 1; };
    }, [provider, loadIfDue]);

    // Refreshing while focused and in the foreground only, and never on top of
    // a read that is already running -- opening the screen must not queue a
    // second ask behind the first.
    useForegroundRefresh(() => { loadIfDue(provider, true); }, FRESH_MS);

    // A pressed tab paints its own last-known payload at once; another tab's
    // payload is not stale data for this one, and an uncached tab skeletons.
    const selectTab = (id: string) => {
        hapticsSelection();
        setProvider(id);
    };
    // The header control and the pull gesture are the same instruction: ask
    // past the cache, now. The budget refuses when a collection has just run;
    // a refusal is named at the control that was pressed, never silent.
    const askNow = (): boolean => {
        if (inFlight.current) return false;
        const waitSeconds = forcedReadWait(lastForced.current, rejected.current, Date.now());
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
        void load(provider, true);
    };
    // A refused press gives the same feedback as one that ran, so the tap never
    // reads as dead.
    const refreshNow = () => {
        hapticsSelection();
        if (!askNow()) return;
        void load(provider, true);
    };

    React.useEffect(() => {
        if (throttledSeconds === undefined) return;
        const timer = setTimeout(() => setThrottledSeconds(undefined), throttledSeconds * 1_000);
        return () => clearTimeout(timer);
    }, [throttledSeconds]);

    const empty = report !== undefined && report.providers.length === 0;
    return (
        <>
            <Header
                title={<Text style={{ fontSize: 16, color: theme.colors.header.tint, ...Typography.default('semiBold') }}>{t('usage.title')}</Text>}
                headerLeft={() => <HeaderBackButton onPress={() => router.back()} label={t('plugins.goBack')} />}
                headerRight={() => <RefreshControlButton busy={busy} throttledSeconds={throttledSeconds} onPress={refreshNow} />}
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
                {error !== undefined && <Pressable onPress={() => { if (askNow()) load(provider, true); }} accessibilityRole="button" accessibilityLabel={`${error}. ${t('plugins.retry')}`} style={{ marginBottom: 8, paddingVertical: 10 }}>
                    <Notice tone="danger" text={error} style={{ marginBottom: 0 }} />
                    <Text style={{ color: theme.colors.textLink, fontSize: 13, marginTop: 4, marginLeft: 14 }}>{t('plugins.retry')}</Text>
                </Pressable>}
                {empty
                    ? <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                        {report?.noProvidersTitle !== undefined && <Text style={{ color: theme.colors.text, fontSize: 16, fontWeight: '600' }}>{report.noProvidersTitle}</Text>}
                        {report?.noProviders !== undefined && <Text style={{ color: theme.colors.textSecondary, fontSize: 14, marginTop: 4, textAlign: 'center' }}>{report.noProviders}</Text>}
                    </View>
                    : <>
                        <ProviderTabs tabs={tabs} active={report?.provider ?? provider} onSelect={selectTab} />
                        {report === undefined
                            ? <UsageSkeleton />
                            : <View style={{ opacity: loading ? 0.55 : 1 }}>
                                <ScreenLimits node={LIMITS_NODE} data={report} />
                                <SectionLabel style={{ marginBottom: 10 }}>Today</SectionLabel>
                                <View style={[cardStyle(theme), { paddingHorizontal: 16, paddingVertical: 12, marginBottom: 14 }]}>
                                    {report.activityNotice !== undefined && <Notice tone="warning" text={report.activityNotice} />}
                                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 10 }}>
                                        <View style={{ flexBasis: '48%', flexGrow: 1 }}><Metric label="Tokens" value={report.todayTokens} /></View>
                                        <View style={{ flexBasis: '48%', flexGrow: 1 }}><Metric label="Cost" value={report.todayCost} /></View>
                                    </View>
                                </View>
                                <SectionLabel style={{ marginBottom: 10 }}>Models today</SectionLabel>
                                <ScreenChart node={MODEL_CHART_NODE} data={report} nested />
                                <SectionLabel style={{ marginBottom: 10, marginTop: 10 }}>Last 7 days</SectionLabel>
                                <View style={[cardStyle(theme), { paddingHorizontal: 16, paddingVertical: 12, marginBottom: 4 }]}>
                                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 10 }}>
                                        <View style={{ flexBasis: '48%', flexGrow: 1 }}><Metric label="Tokens" value={report.weekTokens} /></View>
                                        <View style={{ flexBasis: '48%', flexGrow: 1 }}><Metric label="Cost" value={report.weekCost} /></View>
                                    </View>
                                </View>
                                <ScreenChart node={WEEK_CHART_NODE} data={report} nested />
                                <Text style={{ color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 12 }}>
                                    Local activity and estimated costs are separate from provider plan limits. Prompts and project details stay out.
                                </Text>
                            </View>}
                    </>}
            </View>
            </ScrollView>
        </>
    );
}

/** The screen's explicit "now, past the cache" control. It dims while a read
 *  is running rather than swapping in a spinner, so the control keeps its
 *  place and the figures keep theirs. A refused tap is named here, beside the
 *  control that was pressed, so it cannot scroll away from it. */
function RefreshControlButton({ busy, throttledSeconds, onPress }: { busy: boolean; throttledSeconds?: number; onPress: () => void }) {
    const { theme } = useUnistyles();
    const throttled = throttledSeconds !== undefined;
    const tint = withAlpha(theme.colors.header.tint, busy ? 0.4 : 1);
    return (
        <Pressable onPress={onPress} disabled={busy} hitSlop={10} accessibilityRole="button"
            accessibilityState={{ busy }}
            accessibilityLabel={throttled
                ? `${t('plugins.rightNow.refreshThrottled', { seconds: throttledSeconds })}. ${t('plugins.rightNow.refreshNow')}`
                : t('plugins.rightNow.refreshNow')}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 5, padding: 6 }}>
            <Ionicons name="refresh" size={20} color={tint} />
            {throttled && <Text numberOfLines={1} style={{ fontSize: 11.5, lineHeight: 15, ...Typography.mono('regular'), color: withAlpha(theme.colors.header.tint, 0.7) }}>
                {t('plugins.rightNow.refreshIn', { seconds: throttledSeconds })}
            </Text>}
        </Pressable>
    );
}

/** The same pill strip the declarative tabs node draws: agent mark, short
 *  name, selected fill. A tab means a real integration, so the strip only
 *  lists providers the host measured or found connected. */
function ProviderTabs({ tabs, active, onSelect }: { tabs: UsageReport['providers']; active?: string; onSelect: (id: string) => void }) {
    const { theme } = useUnistyles();
    if (tabs.length === 0) return null;
    return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }} contentContainerStyle={{ gap: 6, paddingRight: 24 }}>
            {tabs.map((tab) => {
                const labelColor = tab.id === active ? theme.colors.surface : theme.colors.textSecondary;
                return (
                    <Pressable key={tab.id} accessibilityRole="tab" accessibilityState={{ selected: tab.id === active }} accessibilityLabel={tab.label}
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

/** Caption + one big mono figure; a missing figure is information, not a
 *  hole (the host sends a dash). */
function Metric({ label, value }: { label: string; value: string }) {
    const { theme } = useUnistyles();
    const blank = value === '' || value === '—';
    return (
        <View style={{ paddingVertical: 10 }}>
            <Text style={{ color: withAlpha(theme.colors.textSecondary, 0.85), fontSize: 12, lineHeight: 16, fontWeight: '600', ...Typography.default('semiBold') }}>{label}</Text>
            <Text style={{ color: blank ? theme.colors.textSecondary : theme.colors.text, fontSize: 30, letterSpacing: -0.5, marginTop: 2, ...Typography.mono('semiBold') }}>{blank ? '—' : value}</Text>
        </View>
    );
}

function UsageSkeleton() {
    const { theme } = useUnistyles();
    return (
        <View style={{ gap: 12, marginTop: 4 }}>
            {[220, 120, 140, 140].map((height, index) => (
                <View key={index} style={{ height, borderRadius: 16, backgroundColor: theme.colors.surfaceHigh }} />
            ))}
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
