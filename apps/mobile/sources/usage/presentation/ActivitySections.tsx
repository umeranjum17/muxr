import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import type { UsageActivity, UsageActivityDay, UsageLimitsWindow, UsageTokenCounts } from '@trymuxr/contract';
import { AgentGlyph } from '@/components/AgentGlyph';
import { cardStyle, Meter, Notice, SectionLabel, withAlpha } from '@/components/ui';
import { Typography } from '@/constants/Typography';
import { toneColor } from '@/plugins';
import { activityInsights, compactMoney, compactTokens, dayTotal, rangeSummary, todayVersusUsual, type Insight } from '../domain/activityModel';

type Span = 7 | 30;

const COST_BASIS: Record<NonNullable<UsageActivity['costBasis']>, string> = {
    recorded: 'as recorded',
    estimated: 'list-price estimate',
    mixed: 'recorded + estimated',
};

const NOT_PRICED = 'Not priced';

function costLabel(cost: number | undefined, partial: boolean): string | undefined {
    if (cost === undefined) return undefined;
    return `${partial ? '≥ ' : ''}${compactMoney(cost)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dateOf(iso: string): Date {
    const [year, month, day] = iso.split('-').map(Number);
    return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

function dayName(iso: string, today: string): string {
    if (iso === today) return 'Today';
    const date = dateOf(iso);
    return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/**
 * A tab's measured activity: today with its hours, what it means, the trend
 * over 7 or 30 days, where it went and which models did the work. Figures are
 * the host's; every word and every mark is drawn here.
 */
export function ActivitySections({ activity, tab, limits, costNote, planPriced }: {
    activity: UsageActivity;
    /** The tab's display name, for sentences. */
    tab: string;
    /** The tab's own plan and every route's, for the pace insight. */
    limits: Array<{ plan: string; windows: UsageLimitsWindow[] }>;
    /** Shown under the figures: whose costs these are. */
    costNote?: string;
    /** The tab's tokens are priced by its plan: no dollar figure here, not even 'Not priced'. */
    planPriced?: boolean;
}) {
    const { theme } = useUnistyles();
    // A tab idle all week opens on the month, where its figures are. The span
    // is the tab's own: the screen keys this by tab, so a pick never carries
    // to another tab, and until one is made the default follows the figures.
    const [picked, setSpan] = React.useState<Span>();
    const span: Span = picked ?? (activity.state === 'measured' && rangeSummary(activity, 7).total === 0 ? 30 : 7);
    if (activity.state === 'counting') return <CountingCard reason={activity.reason} />;
    if (activity.state === 'unavailable') {
        return (
            <View style={{ marginBottom: 14 }}>
                <SectionLabel style={{ marginBottom: 10 }}>Tokens</SectionLabel>
                <View style={[cardStyle(theme), { padding: 16 }]}>
                    <Notice tone="warning" text={activity.reason ?? 'Local activity could not be measured'} style={{ marginBottom: 0 }} />
                </View>
            </View>
        );
    }
    const insights = activityInsights({ activity, tab, limits });
    return (
        <View>
            <TodayCard activity={activity} planPriced={planPriced} />
            {insights.length > 0 && <InsightsCard insights={insights} />}
            {rangeSummary(activity, 30).total > 0 && <TrendCard activity={activity} span={span} onSpan={setSpan} planPriced={planPriced} />}
            {activity.sources !== undefined && activity.sources.length > 0 && <SourcesCard sources={activity.sources} />}
            {activity.routes !== undefined && activity.routes.length > 0 && <RoutesCard activity={activity} span={span} tab={tab} />}
            {activity.models.length > 0 && <ModelsCard activity={activity} span={span} />}
            <Text style={{ color: theme.colors.textSecondary, fontSize: 12.5, lineHeight: 18, marginTop: 2 }}>
                {costNote ?? 'Costs are what each agent records, or list-price estimates where it records none.'} Plans bill by their limits, not by these figures. Prompts and project details never leave this computer.
            </Text>
        </View>
    );
}

function CountingCard({ reason }: { reason?: string }) {
    const { theme } = useUnistyles();
    const reduceMotion = useReducedMotion();
    const pulse = useSharedValue(0.5);
    React.useEffect(() => {
        if (reduceMotion) return;
        let alive = true;
        const cycle = (up: boolean) => {
            if (!alive) return;
            pulse.value = withTiming(up ? 1 : 0.5, { duration: 900, easing: Easing.inOut(Easing.quad) });
            setTimeout(() => cycle(!up), 900);
        };
        cycle(true);
        return () => { alive = false; };
    }, [pulse, reduceMotion]);
    const breathing = useAnimatedStyle(() => ({ opacity: pulse.value }));
    return (
        <View style={{ marginBottom: 14 }}>
            <SectionLabel style={{ marginBottom: 10 }}>Today</SectionLabel>
            <View style={[cardStyle(theme), { padding: 16 }]} accessible accessibilityLabel={reason ?? 'Counting local activity'}>
                <Animated.View style={[{ flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 56, marginBottom: 14 }, breathing]}>
                    {Array.from({ length: 24 }, (_, index) => (
                        <View key={index} style={{ flex: 1, height: 6 + ((index * 37) % 23) * 2, borderRadius: 2, backgroundColor: withAlpha(theme.colors.accent, 0.12) }} />
                    ))}
                </Animated.View>
                <Notice tone="positive" text={reason ?? 'Counting local activity'} style={{ marginBottom: 0 }} />
            </View>
        </View>
    );
}

function Column({ ratio, height, color, delay, radius = 2 }: { ratio: number; height: number; color: string; delay: number; radius?: number }) {
    const reduceMotion = useReducedMotion();
    // A measured zero is zero tall; a positive value is floored so a quiet
    // hour stays visible without inventing activity.
    const target = ratio <= 0 ? 0 : Math.max(2, Math.min(1, ratio) * height);
    const size = useSharedValue(reduceMotion ? target : 0);
    React.useEffect(() => {
        size.value = reduceMotion ? target : withDelay(delay, withTiming(target, { duration: 420, easing: Easing.bezier(0.23, 1, 0.32, 1) }));
    }, [delay, reduceMotion, size, target]);
    const animated = useAnimatedStyle(() => ({ height: size.value }));
    return <Animated.View style={[{ width: '100%', borderTopLeftRadius: radius, borderTopRightRadius: radius, backgroundColor: color }, animated]} />;
}

const SPLIT: Array<{ key: keyof UsageTokenCounts; label: string; alpha: number }> = [
    { key: 'input', label: 'Input', alpha: 1 },
    { key: 'output', label: 'Output', alpha: 0.72 },
    { key: 'cacheWrite', label: 'Cache write', alpha: 0.46 },
    { key: 'cacheRead', label: 'Cache read', alpha: 0.2 },
    { key: 'other', label: 'Other', alpha: 0.1 },
];

function TodayCard({ activity, planPriced }: { activity: UsageActivity; planPriced?: boolean }) {
    const { theme } = useUnistyles();
    const today = activity.days[activity.days.length - 1] ?? { date: '', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, other: 0 };
    const total = dayTotal(today);
    const ratio = todayVersusUsual(activity);
    const cost = costLabel(today.cost, today.unpriced === true);
    const hourly = activity.hourly;
    const peak = Math.max(1, ...hourly);
    const now = hourly.length - 1;
    const busiest = hourly.indexOf(Math.max(...hourly));
    let comparison: string | undefined;
    if (ratio !== undefined && ratio >= 1.1) comparison = `${ratio >= 2 ? `${Number(ratio.toFixed(1))}×` : `${Math.round((ratio - 1) * 100)}% above`} your usual day`;
    else if (ratio !== undefined && ratio <= 0.9) comparison = `${Math.round(ratio * 100)}% of your usual day so far`;
    else if (ratio !== undefined) comparison = 'In line with your usual day';
    const priced = cost === undefined ? undefined : `${cost} ${COST_BASIS[activity.costBasis ?? 'recorded']}`;
    // 'Not priced' is for costs nobody knows; a tab whose plan prices its
    // traffic says nothing here -- its footnote is the one explanation.
    const notPriced = cost === undefined && total > 0 && !planPriced ? NOT_PRICED : undefined;
    const summary = [`Today ${compactTokens(total)} tokens`, total > 0 ? priced ?? notPriced : undefined, comparison,
        hourly.length > 0 && total > 0 ? `busiest hour ${hourLabel(busiest)}` : undefined].filter(Boolean).join(', ');
    return (
        <View style={{ marginBottom: 14 }}>
            <SectionLabel style={{ marginBottom: 10 }}>Today</SectionLabel>
            <View style={[cardStyle(theme), { padding: 16, paddingTop: 14 }]} accessible accessibilityRole="summary" accessibilityLabel={summary}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                    <View style={{ flex: 1 }}>
                        <Text numberOfLines={1} adjustsFontSizeToFit style={{ color: theme.colors.text, fontSize: 34, lineHeight: 40, letterSpacing: -0.8, ...Typography.mono('semiBold') }}>
                            {compactTokens(total)}
                            <Text style={{ color: theme.colors.textSecondary, fontSize: 14, letterSpacing: 0, ...Typography.default('regular') }}> tokens</Text>
                        </Text>
                        {comparison !== undefined && (
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                                {ratio !== undefined && ratio >= 1.1 && <Ionicons name="arrow-up" size={12} color={theme.colors.textSecondary} />}
                                {ratio !== undefined && ratio <= 0.9 && <Ionicons name="arrow-down" size={12} color={theme.colors.textSecondary} />}
                                <Text style={{ flexShrink: 1, color: theme.colors.textSecondary, fontSize: 12.5, lineHeight: 17 }}>{comparison}</Text>
                            </View>
                        )}
                    </View>
                    {/* Tokens nobody priced are not free: they say so, never $0.00. */}
                    {notPriced !== undefined && (
                        <Text style={{ paddingTop: 8, color: theme.colors.textSecondary, fontSize: 12.5, lineHeight: 17 }}>{notPriced}</Text>
                    )}
                    {cost !== undefined && (
                        <View style={{ alignItems: 'flex-end', paddingTop: 6 }}>
                            <Text style={{ color: theme.colors.text, fontSize: 15, lineHeight: 20, ...Typography.mono('semiBold') }}>{cost}</Text>
                            <Text style={{ color: theme.colors.textSecondary, fontSize: 11, lineHeight: 14 }}>{COST_BASIS[activity.costBasis ?? 'recorded']}</Text>
                        </View>
                    )}
                </View>
                {hourly.length > 0 && total > 0 && (
                    <View style={{ marginTop: 14 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 56, gap: 2 }}>
                            {Array.from({ length: 24 }, (_, hour) => (
                                <View key={hour} style={{ flex: 1, height: 56, justifyContent: 'flex-end', alignItems: 'center' }}>
                                    {hour > now
                                        ? <View style={{ width: 3, height: 3, borderRadius: 1.5, backgroundColor: withAlpha(theme.colors.accent, 0.14) }} />
                                        : <Column ratio={(hourly[hour] ?? 0) / peak} height={56} delay={hour * 12} color={hour === now ? theme.colors.accent : withAlpha(theme.colors.accent, 0.42)} />}
                                </View>
                            ))}
                        </View>
                        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.divider }} />
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 5 }}>
                            {['12a', '6a', '12p', '6p', '12a'].map((label, index) => (
                                <Text key={index} style={{ color: theme.colors.textSecondary, fontSize: 10.5, ...Typography.mono('regular') }}>{label}</Text>
                            ))}
                        </View>
                    </View>
                )}
                {total > 0 && <TokenSplit split={today} total={total} />}
            </View>
        </View>
    );
}

function hourLabel(hour: number): string {
    if (hour === 0) return '12am';
    if (hour === 12) return '12pm';
    return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}

/** Where the tokens were: fresh input, output, and the cache the agent
 *  reused -- one 6pt bar in four depths of the accent, and a legend. */
function TokenSplit({ split, total }: { split: UsageTokenCounts; total: number }) {
    const { theme } = useUnistyles();
    // The itemized kinds always speak; 'Other' names the source's unitemized
    // rest, and only while there is any of it.
    const kinds = SPLIT.filter(({ key }) => key !== 'other' || split[key] > 0);
    return (
        <View style={{ marginTop: 14 }}>
            <View style={{ flexDirection: 'row', height: 6, borderRadius: 3, overflow: 'hidden', gap: 1.5, backgroundColor: withAlpha(theme.colors.accent, 0.06) }}>
                {kinds.map(({ key, alpha }) => split[key] > 0 && (
                    <View key={key} style={{ flexGrow: split[key] / total, flexBasis: 0, minWidth: 2, backgroundColor: withAlpha(theme.colors.accent, alpha) }} />
                ))}
            </View>
            {/* Each entry takes its own width and wraps: a narrow phone gets
                more rows instead of ellipsized figures. */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 6, columnGap: 14, marginTop: 8 }}>
                {kinds.map(({ key, label, alpha }) => (
                    <View key={key} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: withAlpha(theme.colors.accent, alpha), borderWidth: alpha < 0.3 ? StyleSheet.hairlineWidth : 0, borderColor: theme.colors.divider }} />
                        <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>
                            {label} <Text style={{ color: theme.colors.text, ...Typography.mono('regular') }}>{compactTokens(split[key])}</Text>
                        </Text>
                    </View>
                ))}
            </View>
        </View>
    );
}

function InsightsCard({ insights }: { insights: Insight[] }) {
    const { theme } = useUnistyles();
    return (
        <View style={{ marginBottom: 14 }}>
            <SectionLabel style={{ marginBottom: 10 }}>Insights</SectionLabel>
            <View style={[cardStyle(theme), { paddingHorizontal: 14, paddingVertical: 4 }]}>
                {insights.map((insight, index) => {
                    const tint = insight.tone === undefined ? theme.colors.textSecondary : toneColor(theme, insight.tone);
                    return (
                        <View key={insight.text} style={{ flexDirection: 'row', gap: 10, paddingVertical: 10, borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider }}>
                            <View style={{ width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: insight.tone === undefined ? theme.colors.accentSubtle : withAlpha(tint, 0.14) }}>
                                <Ionicons name={insight.icon} size={14} color={tint} />
                            </View>
                            <Text style={{ flex: 1, color: theme.colors.text, fontSize: 13.5, lineHeight: 19, paddingTop: 3 }}>{insight.text}</Text>
                        </View>
                    );
                })}
            </View>
        </View>
    );
}

function SpanControl({ span, onSpan }: { span: Span; onSpan: (span: Span) => void }) {
    const { theme } = useUnistyles();
    return (
        <View accessibilityRole="tablist" style={{ flexDirection: 'row', padding: 2, borderRadius: 999, backgroundColor: theme.colors.surfaceHigh, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider }}>
            {([7, 30] as const).map((value) => {
                const selected = value === span;
                return (
                    <Pressable key={value} onPress={() => onSpan(value)} hitSlop={6} accessibilityRole="tab" accessibilityState={{ selected }} accessibilityLabel={`${value} days`}
                        style={{ paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, backgroundColor: selected ? theme.colors.accent : 'transparent' }}>
                        <Text style={{ color: selected ? theme.colors.surface : theme.colors.textSecondary, fontSize: 11.5, ...Typography.mono('semiBold') }}>{value}d</Text>
                    </Pressable>
                );
            })}
        </View>
    );
}

function TrendCard({ activity, span, onSpan, planPriced }: { activity: UsageActivity; span: Span; onSpan: (span: Span) => void; planPriced?: boolean }) {
    const { theme } = useUnistyles();
    const range = rangeSummary(activity, span);
    const today = activity.days[activity.days.length - 1]?.date ?? '';
    const [picked, setPicked] = React.useState<string>();
    const selected: UsageActivityDay | undefined = range.days.find((day) => day.date === picked) ?? range.days[range.days.length - 1];
    const peak = Math.max(1, ...range.days.map(dayTotal));
    const height = 92;
    const averageAt = range.average / peak;
    const rangeCost = costLabel(range.cost, range.partial);
    const selectedCost = selected === undefined ? undefined : costLabel(selected.cost, selected.unpriced === true);
    return (
        <View style={{ marginBottom: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <SectionLabel>Trend</SectionLabel>
                <SpanControl span={span} onSpan={(value) => { setPicked(undefined); onSpan(value); }} />
            </View>
            <View style={[cardStyle(theme), { padding: 16, paddingTop: 14 }]}>
                {selected !== undefined && (
                    <View style={{ marginBottom: 12 }} accessibilityLiveRegion="polite">
                        <Text style={{ color: theme.colors.textSecondary, fontSize: 12, lineHeight: 16 }}>{dayName(selected.date, today)}</Text>
                        <Text style={{ color: theme.colors.text, fontSize: 22, lineHeight: 28, letterSpacing: -0.4, ...Typography.mono('semiBold') }}>
                            {compactTokens(dayTotal(selected))}
                            {selectedCost !== undefined && <Text style={{ color: theme.colors.textSecondary, fontSize: 13, letterSpacing: 0, ...Typography.mono('regular') }}>{`  ${selectedCost}`}</Text>}
                        </Text>
                    </View>
                )}
                <View style={{ height, flexDirection: 'row', alignItems: 'flex-end', gap: span === 7 ? 8 : 2 }}>
                    {range.days.map((day, index) => {
                        const isSelected = day.date === selected?.date;
                        return (
                            <Pressable key={day.date} onPress={() => setPicked(day.date)} accessibilityRole="button"
                                accessibilityLabel={`${dayName(day.date, today)}: ${compactTokens(dayTotal(day))} tokens`}
                                style={{ flex: 1, height, justifyContent: 'flex-end' }}>
                                <Column ratio={dayTotal(day) / peak} height={height} delay={index * (span === 7 ? 30 : 10)} radius={span === 7 ? 3 : 1.5}
                                    color={isSelected ? theme.colors.accent : withAlpha(theme.colors.accent, 0.32)} />
                            </Pressable>
                        );
                    })}
                    {range.average > 0 && (
                        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: Math.max(1, averageAt * height), borderTopWidth: 1, borderStyle: 'dashed', borderTopColor: withAlpha(theme.colors.textSecondary, 0.55) }} />
                    )}
                </View>
                <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.divider }} />
                <View style={{ flexDirection: 'row', marginTop: 5, gap: span === 7 ? 8 : 2 }}>
                    {range.days.map((day, index) => {
                        const date = dateOf(day.date);
                        const last = index === range.days.length - 1;
                        const show = span === 7 || last || (index % 7 === 0 && index < range.days.length - 4);
                        const label = span === 7 ? WEEKDAYS[date.getDay()]!.slice(0, 1) : `${date.getDate()}`;
                        return (
                            <Text key={day.date} numberOfLines={1} style={{ flex: 1, textAlign: 'center', overflow: 'visible', color: day.date === selected?.date ? theme.colors.text : theme.colors.textSecondary, fontSize: 10.5, ...Typography.mono('regular') }}>
                                {show ? label : ''}
                            </Text>
                        );
                    })}
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 4, marginTop: 12 }}>
                    <Figure label={`${span} days`} value={compactTokens(range.total)} />
                    <Figure label="Daily average" value={compactTokens(range.average)} dashed />
                    {rangeCost !== undefined && <Figure label="Cost" value={rangeCost} />}
                    {rangeCost === undefined && range.total > 0 && !planPriced && <Figure label="Cost" value={NOT_PRICED} />}
                </View>
            </View>
        </View>
    );
}

function Figure({ label, value, dashed }: { label: string; value: string; dashed?: boolean }) {
    const { theme } = useUnistyles();
    return (
        <View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                {dashed === true && <View style={{ width: 10, borderTopWidth: 1, borderStyle: 'dashed', borderTopColor: theme.colors.textSecondary }} />}
                <Text style={{ color: theme.colors.textSecondary, fontSize: 11.5, lineHeight: 15 }}>{label}</Text>
            </View>
            <Text style={{ color: theme.colors.text, fontSize: 14, lineHeight: 19, ...Typography.mono('semiBold') }}>{value}</Text>
        </View>
    );
}

/** Tone for what is left of a window: quiet while there is plenty. */
function leftTone(window: UsageLimitsWindow): 'warning' | 'danger' | undefined {
    const left = 100 - Math.round(window.used);
    if (left <= 0 || window.pace === 'limited') return 'danger';
    if (left <= 15) return 'warning';
    return undefined;
}

function tightest(windows: UsageLimitsWindow[] | undefined): UsageLimitsWindow | undefined {
    return (windows ?? []).reduce<UsageLimitsWindow | undefined>((worst, window) => (worst === undefined || window.used > worst.used ? window : worst), undefined);
}

/** An aggregator's traffic by provider, each with that provider's own plan
 *  limit where one is connected: never a plan of the aggregator's own. */
function RoutesCard({ activity, span, tab }: { activity: UsageActivity; span: Span; tab: string }) {
    const { theme } = useUnistyles();
    const value = (route: { week: number; month: number }) => (span === 7 ? route.week : route.month);
    const routes = [...(activity.routes ?? [])].filter((route) => value(route) > 0 || route.windows !== undefined).sort((a, b) => value(b) - value(a));
    const all = routes.reduce((sum, route) => sum + value(route), 0);
    if (routes.length === 0) return null;
    return (
        <View style={{ marginBottom: 14 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', columnGap: 12, rowGap: 2, marginBottom: 10 }}>
                <SectionLabel>By provider</SectionLabel>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 11.5, ...Typography.mono('regular') }}>{`${tab} has no plan of its own`}</Text>
            </View>
            <View style={[cardStyle(theme), { paddingHorizontal: 16, paddingVertical: 4 }]}>
                {routes.map((route, index) => {
                    const share = all === 0 ? 0 : value(route) / all;
                    const cost = span === 7 ? route.weekCost : route.monthCost;
                    const partial = span === 7 ? route.weekUnpriced === true : route.monthUnpriced === true;
                    const model = activity.models.find((candidate) => candidate.route === route.label);
                    const limit = tightest(route.windows);
                    const tone = limit === undefined ? undefined : leftTone(limit);
                    return (
                        <View key={route.id} style={{ paddingVertical: 12, borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider }}
                            accessible accessibilityLabel={[`${route.label}: ${compactTokens(value(route))} tokens${cost === undefined ? '' : `, ${costLabel(cost, partial)}`}, ${Math.round(share * 100)} percent`,
                                limit === undefined ? undefined : `${route.plan ?? route.label} ${limit.label} ${100 - Math.round(limit.used)} percent left${limit.resetsIn === undefined ? '' : `, resets in ${limit.resetsIn}`}`].filter(Boolean).join('. ')}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                <AgentGlyph name={route.glyph ?? route.label} size={16} color={theme.colors.textSecondary} />
                                <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.text, fontSize: 14, ...Typography.default('semiBold') }}>{route.label}</Text>
                                <Text style={{ color: theme.colors.text, fontSize: 13, ...Typography.mono('semiBold') }}>
                                    {compactTokens(value(route))}
                                    {cost !== undefined && <Text style={{ color: theme.colors.textSecondary, fontSize: 12, letterSpacing: 0, ...Typography.mono('regular') }}>{`  · ${costLabel(cost, partial)}`}</Text>}
                                </Text>
                                <Text style={{ width: 38, textAlign: 'right', color: theme.colors.textSecondary, fontSize: 12, ...Typography.mono('regular') }}>{`${Math.round(share * 100)}%`}</Text>
                            </View>
                            <Meter ratio={share} emphasis={0.85} style={{ marginTop: 7, marginLeft: 24 }} />
                            {(model !== undefined || limit !== undefined) && (
                                <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 6, marginTop: 6, marginLeft: 24 }}>
                                    {model !== undefined && <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.textSecondary, fontSize: 12, ...Typography.mono('regular') }}>{model.model}</Text>}
                                    {limit !== undefined && (
                                        <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 12 }}>
                                            {model !== undefined ? '· ' : ''}{`${limit.label} `}
                                            <Text style={{ color: tone === undefined ? theme.colors.text : toneColor(theme, tone), ...Typography.mono('semiBold') }}>{`${100 - Math.round(limit.used)}% left`}</Text>
                                            {limit.resetsIn === undefined ? '' : ` · ${limit.resetsIn}`}
                                        </Text>
                                    )}
                                </View>
                            )}
                        </View>
                    );
                })}
            </View>
        </View>
    );
}

/** A plan's traffic by the harness that sent it, over the last 7 days. */
function SourcesCard({ sources }: { sources: NonNullable<UsageActivity['sources']> }) {
    const { theme } = useUnistyles();
    const all = sources.reduce((sum, source) => sum + source.week, 0);
    return (
        <View style={{ marginBottom: 14 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', columnGap: 12, rowGap: 2, marginBottom: 10 }}>
                <SectionLabel>Who used this plan</SectionLabel>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 11.5, ...Typography.mono('regular') }}>7 days</Text>
            </View>
            <View style={[cardStyle(theme), { paddingHorizontal: 16, paddingVertical: 12, gap: 12 }]}>
                {sources.map((source) => {
                    const share = all === 0 ? 0 : source.week / all;
                    return (
                        <View key={source.id} accessible accessibilityLabel={`${source.label}: ${compactTokens(source.week)} tokens, ${Math.round(share * 100)} percent`}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                                <AgentGlyph name={source.glyph} size={16} color={theme.colors.textSecondary} />
                                <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.text, fontSize: 13.5 }}>{source.label}</Text>
                                <Text style={{ color: theme.colors.text, fontSize: 13, ...Typography.mono('semiBold') }}>{compactTokens(source.week)}</Text>
                                <Text style={{ width: 38, textAlign: 'right', color: theme.colors.textSecondary, fontSize: 12, ...Typography.mono('regular') }}>{`${Math.round(share * 100)}%`}</Text>
                            </View>
                            <Meter ratio={share} emphasis={0.85} style={{ marginLeft: 24 }} />
                        </View>
                    );
                })}
            </View>
        </View>
    );
}

function ModelsCard({ activity, span }: { activity: UsageActivity; span: Span }) {
    const { theme } = useUnistyles();
    const value = (model: { week: number; month: number }) => (span === 7 ? model.week : model.month);
    const models = activity.models.filter((model) => value(model) > 0).sort((a, b) => value(b) - value(a)).slice(0, 6);
    if (models.length === 0) return null;
    const peak = Math.max(1, value(models[0]!));
    return (
        <View style={{ marginBottom: 14 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', columnGap: 12, rowGap: 2, marginBottom: 10 }}>
                <SectionLabel>Top models</SectionLabel>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 11.5, ...Typography.mono('regular') }}>{`${span} days`}</Text>
            </View>
            <View style={[cardStyle(theme), { paddingHorizontal: 16, paddingVertical: 14, gap: 12 }]}>
                {models.map((model, index) => (
                    <View key={`${model.route ?? ''}/${model.model}`} accessible accessibilityLabel={`${model.model}${model.route === undefined ? '' : ` via ${model.route}`}: ${compactTokens(value(model))} tokens`}>
                        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 5 }}>
                            <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.text, fontSize: 13, ...Typography.mono('regular') }}>
                                {model.model}
                                {model.route !== undefined && <Text style={{ color: theme.colors.textSecondary, ...Typography.default('regular') }}>{`  ${model.route}`}</Text>}
                            </Text>
                            <Text style={{ color: theme.colors.text, fontSize: 12.5, ...Typography.mono('semiBold') }}>{compactTokens(value(model))}</Text>
                        </View>
                        <Meter ratio={value(model) / peak} emphasis={1 - index * 0.1} delay={index * 40} />
                    </View>
                ))}
            </View>
        </View>
    );
}
