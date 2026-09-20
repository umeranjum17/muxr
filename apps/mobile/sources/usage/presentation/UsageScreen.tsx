import * as React from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useLocalSearchParams } from 'expo-router';
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
    const routeParams = useLocalSearchParams<{ provider?: string }>();
    const requestedProvider = typeof routeParams.provider === 'string' ? routeParams.provider.slice(0, 32) : '';
    const [provider, setProvider] = React.useState(requestedProvider);
    const [fetched, setFetched] = React.useState<{ key: string; value?: UsageReport }>(() => ({ key: provider, value: reportCache.get(provider) }));
    const [error, setError] = React.useState<string>();
    const [refreshing, setRefreshing] = React.useState(false);
    const [loading, setLoading] = React.useState(!reportCache.has(provider));
    const version = React.useRef(0);
    const staleRef = React.useRef(false);

    const report = fetched.key === provider ? fetched.value : reportCache.get(provider);
    const tabs = report?.providers ?? [];

    const load = React.useCallback((target: string, refresh = false): Promise<void> => {
        const request = ++version.current;
        if (!refresh) setLoading(true);
        setError(undefined);
        return sync.request('usage.report', { ...(target === '' ? {} : { provider: target }), ...(refresh ? { refresh: true } : {}) }, PLUGIN_CALL_CLIENT_TIMEOUT_MS)
            .then((value) => {
                if (request !== version.current) return;
                reportCache.set(target, value);
                while (reportCache.size > MAX_CACHED_REPORTS) reportCache.delete(reportCache.keys().next().value!);
                setFetched({ key: target, value });
                // Last-known numbers paint at once; a payload flagged stale by
                // the host revalidates quietly once -- asking for fresh data
                // by name -- and swaps in place. The revalidation never chains.
                if (value.stale === true && !staleRef.current) {
                    staleRef.current = true;
                    void load(target, true).finally(() => { staleRef.current = false; });
                } else {
                    staleRef.current = false;
                }
            })
            .catch((cause: unknown) => {
                if (request !== version.current) return;
                setError(cause instanceof Error ? cause.message : String(cause));
            })
            .finally(() => {
                if (request !== version.current) return;
                setLoading(false);
                setRefreshing(false);
            });
    }, []);

    React.useEffect(() => {
        load(provider);
        return () => { version.current += 1; };
    }, [provider, load]);

    // A pressed tab paints its own last-known payload at once; another tab's
    // payload is not stale data for this one, and an uncached tab skeletons.
    const selectTab = (id: string) => {
        hapticsSelection();
        setProvider(id);
    };
    const onRefresh = () => { setRefreshing(true); load(provider, true); };

    const empty = report !== undefined && report.providers.length === 0;
    return (
        <ScrollView
            style={{ flex: 1, backgroundColor: theme.colors.surface }}
            contentContainerStyle={{ paddingTop: insets.top + 58, paddingBottom: insets.bottom + 40 }}
            refreshControl={<RefreshControl refreshing={refreshing} tintColor={theme.colors.textSecondary} onRefresh={onRefresh} />}
        >
            <View style={{ width: '100%', maxWidth: 720, alignSelf: 'center', padding: 14, paddingTop: 10 }}>
                <LoadingHairline active={loading && report === undefined} />
                {error !== undefined && <Pressable onPress={() => load(provider)} accessibilityRole="button" accessibilityLabel={`${error}. ${t('plugins.retry')}`} style={{ marginBottom: 8, paddingVertical: 10 }}>
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
