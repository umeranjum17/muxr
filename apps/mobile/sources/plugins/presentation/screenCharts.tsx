import * as React from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { PolarChart, Pie } from 'victory-native';
import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import Animated, { Easing, useAnimatedStyle, useDerivedValue, useReducedMotion, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import type { PluginScreenChartNode, PluginScreenTone } from '@muxr/contract';
import type { Theme } from '@/theme';
import { toneColor } from '../domain/pluginTone';
import { bindText, resolvePath } from '../domain/screenModel';
import { resolvePluginText } from '../domain/pluginText';
import { asChartSeries, type PluginChartItem } from '../domain/chartModel';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { cardStyle, Meter, SectionLabel, withAlpha } from '@/components/ui';
import { useScreenContentWidth } from './pluginScreenLayout';

/** Chart fills: untoned series get the accent, never a per-index rainbow. */
function chartFill(theme: Theme, tone: PluginScreenTone | undefined): string {
    return tone === undefined ? theme.colors.accent : toneColor(theme, tone);
}

/**
 * Rank by depth of one hue, never by a categorical rainbow: borrowing the
 * status colours for slice three and four is what makes a chart look cheap, and
 * it spends red on a series that is not in trouble.
 */
function rampFill(theme: Theme, index: number, count: number): string {
    const step = count <= 1 ? 0 : index / (count - 1);
    return withAlpha(theme.colors.accent, 1 - step * 0.62);
}

function chartValue(item: PluginChartItem): string {
    return item.valueLabel ?? String(item.value);
}

function chartSummary(title: string | undefined, series: PluginChartItem[], variant: PluginScreenChartNode['variant'], total: number): string {
    const parts = series.map((item) => {
        const value = variant === 'ring'
            ? `${Math.round(item.value / total * 100)} percent`
            : chartValue(item);
        if (item.detail === undefined) return `${item.label} ${value}`;
        return `${item.label} ${value} ${item.detail}`;
    });
    return `${title ?? 'Chart'}: ${parts.join(', ')}`;
}

/**
 * Open-bottom arc, so the gap reads as the scale's start and end rather than as
 * a slice that was left out of a pie.
 */
function GaugeArc({ ratio, size, color, track }: { ratio: number; size: number; color: string; track: string }) {
    const reduceMotion = useReducedMotion();
    const sweep = useSharedValue(reduceMotion ? ratio : 0);
    React.useEffect(() => {
        sweep.value = reduceMotion ? ratio : withTiming(ratio, { duration: 620, easing: Easing.bezier(0.23, 1, 0.32, 1) });
    }, [ratio, reduceMotion, sweep]);
    const stroke = size * 0.085;
    const radius = (size - stroke) / 2;
    const box = Skia.XYWHRect(stroke / 2, stroke / 2, radius * 2, radius * 2);
    const START = 135;
    const SPAN = 270;
    const trackPath = React.useMemo(() => {
        const path = Skia.Path.Make();
        path.addArc(box, START, SPAN);
        return path;
    }, [box]);
    const valuePath = useDerivedValue(() => {
        const path = Skia.Path.Make();
        path.addArc(box, START, Math.max(0.001, SPAN * sweep.value));
        return path;
    });
    return (
        <Canvas style={{ width: size, height: size }}>
            <Path path={trackPath} color={track} style="stroke" strokeWidth={stroke} strokeCap="round" />
            <Path path={valuePath} color={color} style="stroke" strokeWidth={stroke} strokeCap="round" />
        </Canvas>
    );
}

function AnimatedColumn({ ratio, color, delay }: { ratio: number; color: string; delay: number }) {
    const reduceMotion = useReducedMotion();
    const height = useSharedValue(reduceMotion ? ratio : 0);
    React.useEffect(() => {
        height.value = reduceMotion ? ratio : withDelay(delay, withTiming(ratio, { duration: 480, easing: Easing.bezier(0.23, 1, 0.32, 1) }));
    }, [delay, ratio, reduceMotion, height]);
    // Floored so an idle day stays a visible baseline instead of disappearing.
    const animated = useAnimatedStyle(() => ({ height: `${Math.max(2, Math.min(1, height.value) * 100)}%` }));
    // No track behind the column: seven filled boxes with lighter boxes inside
    // read as blocks, not as a shape you can compare across days.
    return (
        <View style={{ width: '100%', flex: 1, justifyContent: 'flex-end' }}>
            <Animated.View style={[{ width: '100%', borderTopLeftRadius: 3, borderTopRightRadius: 3, backgroundColor: color }, animated]} />
        </View>
    );
}

function MeterRow({ item, ratio, emphasis, delay, hero }: { item: PluginChartItem; ratio: number; emphasis: number; delay: number; hero?: boolean }) {
    const { theme } = useUnistyles();
    const valueColor = item.tone === undefined || item.tone === 'secondary'
        ? theme.colors.text
        : toneColor(theme, item.tone);
    return (
        <View>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', marginBottom: 5 }}>
                <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 13, flex: 1, marginRight: 12 }}>{item.label}</Text>
                <Text style={{ color: valueColor, fontSize: hero === true ? 20 : 12.5, letterSpacing: hero === true ? -0.4 : 0, ...Typography.mono('semiBold') }}>{chartValue(item)}</Text>
                {item.detail !== undefined && <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 11.5, marginLeft: 8, ...Typography.mono('regular') }}>{item.detail}</Text>}
            </View>
            <Meter ratio={ratio} emphasis={emphasis} delay={delay} />
        </View>
    );
}

/**
 * Label, number, bar, qualifier. A ranked series, a gauge and a ring all reduce
 * to this, which is why a phone can decline three desktop chart shapes and lose
 * no information: an arc and a bar encode the same scalar, and a donut's legend
 * has to reprint every value anyway.
 */
export function ScreenChart({ node, data, nested }: { node: PluginScreenChartNode; data: unknown; nested: boolean }) {
    const { theme } = useUnistyles();
    const reduceMotion = useReducedMotion();
    // The plugin declares what the number means; this decides what it can look
    // like at this width. An arc and a donut are dashboard shapes, and a phone
    // is not a dashboard.
    // ponytail: window width, not the card's. Plugin screens own the content
    // area today; measure the card with onLayout if one ever renders in a
    // narrow column on a wide screen.
    const wide = useScreenContentWidth() >= 680;
    const series = asChartSeries(resolvePath(data, node.path));
    const title = node.title === undefined ? undefined : bindText(resolvePluginText(node.title), data);
    const empty = node.emptyText === undefined ? t('plugins.nothingToShow') : bindText(resolvePluginText(node.emptyText), data);
    // Empty says so in one quiet line. A full card drawn around "nothing yet"
    // spends the same space as real data. Inside a section the owning title
    // already carries the context, so an empty chart leaves no trace at all.
    if (series.length === 0 && nested && title !== undefined) return null;
    if (series.length === 0) {
        return (
            <View style={{ marginBottom: nested ? 8 : 14 }}>
                {title !== undefined && <SectionLabel style={{ marginBottom: 4, marginTop: nested ? 10 : 0 }}>{title}</SectionLabel>}
                <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>{empty}</Text>
            </View>
        );
    }
    const total = series.reduce((sum, item) => sum + item.value, 0);
    const summary = chartSummary(title, series, node.variant, total);
    const card: ViewStyle = nested
        ? { marginBottom: 4 }
        : { ...cardStyle(theme), marginBottom: 14, padding: 16 };
    const heading = title === undefined ? null : (
        <SectionLabel style={{ marginBottom: 12, marginTop: nested ? 10 : 0 }}>{title}</SectionLabel>
    );

    // One value against its ceiling. A two-slice donut says the same thing with
    // a second slice that carries no information of its own.
    if (node.variant === 'gauge') {
        const hero = series[0]!;
        const ratio = Math.max(0, Math.min(1, total === 0 ? 0 : hero.value / total));
        return (
            <View accessible accessibilityRole="progressbar" accessibilityLabel={summary}
                accessibilityValue={{ min: 0, max: 100, now: Math.round(ratio * 100) }} style={card}>
                {heading}
                {!wide && <MeterRow item={hero} ratio={ratio} emphasis={1} delay={0} hero />}
                {wide && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                        {/* The arc is the picture and the number beside it is the
                            value; printing it inside the arc as well said it twice. */}
                        <View style={{ width: 84, height: 84 }}>
                            <GaugeArc ratio={ratio} size={84} color={theme.colors.accent} track={withAlpha(theme.colors.accent, 0.1)} />
                        </View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                            <SectionLabel numberOfLines={1}>{hero.label}</SectionLabel>
                            <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 28, letterSpacing: -0.8, marginTop: 2, ...Typography.mono('semiBold') }}>{chartValue(hero)}</Text>
                            {hero.detail !== undefined && <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 2, ...Typography.mono('regular') }}>{hero.detail}</Text>}
                        </View>
                    </View>
                )}
            </View>
        );
    }

    // Time reads left to right. Ranking a series of days destroys the shape.
    if (node.variant === 'column') {
        const peak = Math.max(...series.map((item) => item.value));
        const last = series.length - 1;
        const peakIndex = series.findIndex((item) => item.value === peak);
        return (
            <View accessible accessibilityRole="image" accessibilityLabel={summary} style={card}>
                {heading}
                <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: wide ? 104 : 64, gap: 6 }}>
                    {series.map((item, index) => (
                        <View key={`${item.label}-${index}`} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
                            {(index === last || index === peakIndex) && <Text numberOfLines={1} style={{ color: index === last ? theme.colors.text : theme.colors.textSecondary, fontSize: 11, marginBottom: 4, ...Typography.mono('semiBold') }}>{chartValue(item)}</Text>}
                            <AnimatedColumn ratio={peak === 0 ? 0 : item.value / peak} delay={index * 45}
                                color={index === last ? theme.colors.accent : withAlpha(theme.colors.accent, 0.28)} />
                        </View>
                    ))}
                </View>
                <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.divider }} />
                <View style={{ flexDirection: 'row', gap: 6, marginTop: 8 }}>
                    {series.map((item, index) => (
                        <Text key={`${item.label}-${index}-label`} numberOfLines={1}
                            style={{ flex: 1, textAlign: 'center', color: index === last ? theme.colors.text : theme.colors.textSecondary, fontSize: 11 }}>{item.label}</Text>
                    ))}
                </View>
            </View>
        );
    }

    if (node.variant === 'ring') {
        // First slice is the hero: its value/label sit in the donut center.
        const hero = series[0]!;
        const sliceColor = (item: PluginChartItem, index: number) => {
            if (item.tone === 'secondary') return theme.colors.surfaceHighest;
            if (item.tone !== undefined) return chartFill(theme, item.tone);
            return rampFill(theme, index, series.length);
        };
        const slices = series.map((item, index) => ({ label: item.label, value: item.value, color: sliceColor(item, index) }));
        if (!wide) {
            // The remainder slice is exactly what the empty part of a meter
            // already draws, so used/left collapses to a single row.
            const parts = series.filter((item) => item.tone !== 'secondary');
            return (
                <View accessible accessibilityRole="image" accessibilityLabel={summary} style={{ ...cardStyle(theme), marginBottom: 14, padding: 16 }}>
                    {title !== undefined && <SectionLabel style={{ marginBottom: 12 }}>{title}</SectionLabel>}
                    <View style={{ gap: 12 }}>
                        {parts.map((item, index) => (
                            <MeterRow key={`${item.label}-${index}`} item={item} ratio={total === 0 ? 0 : item.value / total}
                                emphasis={1 - index * 0.18} delay={index * 45} hero={parts.length === 1} />
                        ))}
                    </View>
                </View>
            );
        }
        return (
            <View accessible accessibilityRole="image" accessibilityLabel={summary}
                style={{ ...cardStyle(theme), marginBottom: 14, padding: 16 }}>
                {title !== undefined && <SectionLabel style={{ marginBottom: 12 }}>{title}</SectionLabel>}
                <View style={{ alignItems: 'center' }}>
                    <View style={{ width: 132, height: 132 }}>
                        <PolarChart data={slices} labelKey="label" valueKey="value" colorKey="color" containerStyle={{ width: 132, height: 132 }}>
                            <Pie.Chart innerRadius="74%" startAngle={-90}>
                                {() => <Pie.Slice {...(reduceMotion ? {} : { animate: { type: 'timing', duration: 500, easing: Easing.bezier(0.23, 1, 0.32, 1) } })} />}
                            </Pie.Chart>
                        </PolarChart>
                        <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
                            <Text style={{ color: theme.colors.text, fontSize: 24, letterSpacing: -0.5, ...Typography.mono('semiBold') }}>{chartValue(hero)}</Text>
                            <Text style={{ color: theme.colors.textSecondary, fontSize: 11, marginTop: 1 }}>{hero.label}</Text>
                        </View>
                    </View>
                </View>
                {/* Two slices are Left/Used: the centre already names both. */}
                {series.length >= 3 && (
                    <View style={{ marginTop: 14 }}>
                        {series.map((item, index) => (
                            <View key={`${item.label}-${index}-legend`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 }}>
                                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: sliceColor(item, index) }} />
                                <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.textSecondary, fontSize: 12 }}>{item.label}</Text>
                                <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 12, ...Typography.mono('regular') }}>{chartValue(item)}</Text>
                            </View>
                        ))}
                    </View>
                )}
            </View>
        );
    }

    const max = Math.max(...series.map((item) => item.value));
    return (
        <View style={card} accessible accessibilityRole="image" accessibilityLabel={summary}>
            {heading}
            <View style={{ gap: 12 }}>
                {series.map((item, index) => (
                    <MeterRow key={`${item.label}-${index}`} item={item} ratio={max === 0 ? 0 : item.value / max}
                        emphasis={1 - index * 0.18} delay={index * 45} />
                ))}
            </View>
        </View>
    );
}
