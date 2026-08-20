import * as React from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { PolarChart, Pie } from 'victory-native';
import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import Animated, { Easing, FadeInDown, cancelAnimation, useAnimatedStyle, useDerivedValue, useReducedMotion, useSharedValue, withDelay, withRepeat, withSpring, withTiming } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import type { PluginManifestV1, PluginScreenButtonNode, PluginScreenChartNode, PluginScreenContribution, PluginScreenNode, PluginScreenRowAction, PluginScreenRowNode, PluginScreenTone, PluginScreenTreeNode, PluginSource, PluginText, RequestParams } from '@muxr/contract';
import { MAX_SCREEN_LIST_ROWS, PLUGIN_CALL_CLIENT_TIMEOUT_MS, capUtf8Bytes, defaultPluginText, sanitizeDisplayText } from '@muxr/contract';
import type { Theme } from '@/theme';
import { Switch } from '@/components/Switch';
import { hapticsError, hapticsSelection, hapticsSuccess } from '@/components/haptics';
import { PierreDiffView } from '@/components/diff/PierreDiffView';
import { SyntaxHighlightedCode } from '@/components/code/SyntaxHighlightedCode';
import { sync } from '@/sync/sync';
import { pluginSnapshot } from './pluginStore';
import { dispatchPluginAction } from './pluginActions';
import { clearPluginCache, registerPluginDataCacheInvalidator, subscribePluginDataInvalidation } from './pluginDataInvalidation';
import { toneColor } from './pluginTone';
import { bindText, initialFieldValues, loadScreenData, resolvePath, runScreenButton, sharedPluginWriteKeys, shouldReloadAfterAction, type ScreenFieldValues } from './screenModel';
import { resolvePluginText } from './pluginText';
import { asScreenTree, type RuntimeTreeItem } from './screenTreeModel';
import { asChartSeries, type PluginChartItem } from './chartModel';
import { fileIcon, folderIcon, type FileIcon } from './fileIcon';
import { t } from '@/text';
import { boundText } from '@/utils/boundedText';
import { Typography } from '@/constants/Typography';
import { cardStyle, Meter, SectionLabel, ui, withAlpha } from '@/components/ui';

/** Screen payloads survive a close: reopening renders at once, then refreshes. */
const screenCache = new Map<string, unknown>();
registerPluginDataCacheInvalidator((pluginIds) => {
    if (pluginIds === undefined) screenCache.clear();
    else for (const pluginId of pluginIds) clearPluginCache(screenCache, pluginId);
});

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

function AnimatedColumn({ ratio, color, track, delay }: { ratio: number; color: string; track: string; delay: number }) {
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

function chartValue(item: PluginChartItem): string {
    return item.valueLabel ?? String(item.value);
}

/** Indeterminate 2px bar: says "working" without taking the content's place. */
function LoadingHairline({ active }: { active: boolean }) {
    const { theme } = useUnistyles();
    const reduceMotion = useReducedMotion();
    const { width } = useWindowDimensions();
    const progress = useSharedValue(0);
    React.useEffect(() => {
        if (!active || reduceMotion) {
            cancelAnimation(progress);
            progress.value = 0;
            return;
        }
        progress.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.inOut(Easing.ease) }), -1, false);
        return () => cancelAnimation(progress);
    }, [active, reduceMotion, progress]);
    const animated = useAnimatedStyle(() => ({ transform: [{ translateX: (progress.value * 1.35 - 0.35) * width }] }));
    // The track keeps its 2px even when idle, so content never jumps on load.
    if (!active) return <View style={{ height: 2, marginBottom: 8 }} />;
    return (
        <View style={{ height: 2, marginBottom: 8, borderRadius: 1, overflow: 'hidden', backgroundColor: withAlpha(theme.colors.accent, 0.16) }}>
            {reduceMotion
                ? <View style={{ height: 2, width: '100%', backgroundColor: withAlpha(theme.colors.accent, 0.5) }} />
                : <Animated.View style={[{ height: 2, width: '35%', borderRadius: 1, backgroundColor: theme.colors.accent }, animated]} />}
        </View>
    );
}

function ScreenSkeleton() {
    const { theme } = useUnistyles();
    return (
        <View style={{ gap: 12, marginTop: 4 }}>
            {[96, 140, 72].map((height) => (
                <View key={height} style={{ height, borderRadius: 16, backgroundColor: theme.colors.surfaceHigh }} />
            ))}
        </View>
    );
}

function ScreenRow(props: {
    row: PluginScreenRowNode;
    data: unknown;
    item?: unknown;
    /** Rows on a card need the next surface up to read as pressed. */
    insideCard?: boolean;
    onRowAction: (action: PluginScreenRowAction, item: unknown) => void;
    style?: StyleProp<ViewStyle>;
}) {
    const { theme } = useUnistyles();
    const { row, item } = props;
    const bind = (value: PluginText) => bindText(resolvePluginText(value), props.data, item);
    const action = row.action;
    const value = row.value === undefined ? undefined : bind(row.value);
    const body = (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
                {/* Two lines is a subject line; past that a list of commits turns
                    into a wall and you can see four of them on a phone. */}
                <Text numberOfLines={2} style={{ color: theme.colors.text, fontSize: 15, lineHeight: 20, letterSpacing: -0.1 }}>{bind(row.title)}</Text>
                {row.subtitle !== undefined && <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 11.5, lineHeight: 15, marginTop: 3, ...Typography.mono('regular') }}>{bind(row.subtitle)}</Text>}
            </View>
            {value !== undefined && <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 13, maxWidth: '45%', ...Typography.mono('regular') }}>{value}</Text>}
            {action?.type === 'screen' && <Ionicons name="chevron-forward" size={13} color={withAlpha(theme.colors.textSecondary, 0.6)} />}
        </View>
    );
    // A row without an action stays non-interactive.
    if (action === undefined) return <View style={props.style}>{body}</View>;
    const pressedColor = props.insideCard === true ? theme.colors.surfaceHighest : theme.colors.surfacePressed;
    return (
        <Pressable onPress={() => props.onRowAction(action, item)} accessibilityRole="button"
            accessibilityLabel={[bind(row.title), value].filter((part) => part !== undefined && part !== '').join(', ')}
            style={({ pressed }) => [props.style, pressed && { backgroundColor: pressedColor }]}>
            {body}
        </Pressable>
    );
}

/** Plugin replies are untrusted: keep only well-formed, bounded tab entries. */
function asScreenTabs(value: unknown): Array<{ id: string; label: string }> {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return [];
        const { id, label } = entry as { id?: unknown; label?: unknown };
        if (typeof id !== 'string' || id === '' || typeof label !== 'string' || label === '') return [];
        return [{ id: id.slice(0, 64), label: label.slice(0, 32) }];
    }).slice(0, 16);
}

function treeIcon(item: RuntimeTreeItem, expanded: boolean): FileIcon {
    return item.kind === 'folder' ? folderIcon(expanded) : fileIcon(item.name);
}

function ScreenTree(props: {
    node: PluginScreenTreeNode;
    data: unknown;
    fields: ScreenFieldValues;
    setField: (id: string, value: string | boolean) => void;
    onRowAction: (action: PluginScreenRowAction, item: unknown) => void;
    loadChildren?: (path: string) => Promise<RuntimeTreeItem[]>;
    onError: (error: unknown) => void;
}) {
    const { theme } = useUnistyles();
    const incoming = React.useMemo(() => asScreenTree(resolvePath(props.data, props.node.path)), [props.data, props.node.path]);
    const [items, setItems] = React.useState(incoming);
    const [loading, setLoading] = React.useState(new Set<string>());
    React.useEffect(() => setItems(incoming), [incoming]);
    const folders = React.useMemo(() => {
        const found: string[] = [];
        const walk = (nodes: RuntimeTreeItem[]) => nodes.forEach((item) => {
            if (item.kind === 'folder') { found.push(item.path); walk(item.children); }
        });
        walk(items);
        return found;
    }, [items]);
    const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());
    React.useEffect(() => setExpanded(new Set()), [props.node.path]);
    const rows: Array<{ item: RuntimeTreeItem; depth: number }> = [];
    const flatten = (nodes: RuntimeTreeItem[], depth: number) => nodes.forEach((item) => {
        rows.push({ item, depth });
        if (item.kind === 'folder' && expanded.has(item.path)) flatten(item.children, depth + 1);
    });
    flatten(items, 0);
    const title = props.node.title === undefined ? undefined : bindText(resolvePluginText(props.node.title), props.data);
    return <View style={{ marginBottom: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
            {title !== undefined && <SectionLabel style={{ flex: 1 }}>{title}</SectionLabel>}
            {folders.length > 0 && <>
                <Pressable onPress={() => setExpanded(new Set(folders))} accessibilityRole="button" accessibilityLabel="Expand all folders" hitSlop={12}
                    style={{ minHeight: 32, justifyContent: 'center' }}>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 12, paddingHorizontal: 8 }}>Expand all</Text>
                </Pressable>
                <Pressable onPress={() => setExpanded(new Set())} accessibilityRole="button" accessibilityLabel="Collapse all folders" hitSlop={12}
                    style={{ minHeight: 32, justifyContent: 'center' }}>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>Collapse</Text>
                </Pressable>
            </>}
        </View>
        <View style={{ ...cardStyle(theme), paddingVertical: 6 }}>
            {rows.length === 0 ? <Text style={{ color: theme.colors.textSecondary, fontSize: 13, padding: 14 }}>
                {props.node.emptyText === undefined ? t('plugins.nothingToShow') : bindText(resolvePluginText(props.node.emptyText), props.data)}
            </Text> : rows.map(({ item, depth }) => {
                const isFolder = item.kind === 'folder';
                const open = expanded.has(item.path);
                const busy = loading.has(item.path);
                const selected = props.node.selectionField !== undefined && props.fields[props.node.selectionField] === item.path;
                const icon = treeIcon(item, open);
                return <Pressable key={item.path} accessibilityRole="button" accessibilityState={{ expanded: isFolder ? open : undefined, selected }}
                    accessibilityLabel={`${isFolder ? 'Folder' : 'File'} ${item.name}`}
                    onPress={() => {
                        if (!isFolder) {
                            if (props.node.action !== undefined) props.onRowAction(props.node.action, item);
                            return;
                        }
                        if (props.node.selectionField !== undefined) props.setField(props.node.selectionField, item.path);
                        if (open) {
                            setExpanded((current) => { const next = new Set(current); next.delete(item.path); return next; });
                            return;
                        }
                        const reveal = () => setExpanded((current) => new Set(current).add(item.path));
                        if (item.children.length > 0 || !item.hasChildren || props.loadChildren === undefined) {
                            reveal();
                            return;
                        }
                        setLoading((current) => new Set(current).add(item.path));
                        void props.loadChildren(item.path).then((children) => {
                            const replace = (nodes: RuntimeTreeItem[]): RuntimeTreeItem[] => nodes.map((candidate) =>
                                candidate.path === item.path ? { ...candidate, children, hasChildren: children.length > 0 }
                                    : { ...candidate, children: replace(candidate.children) });
                            setItems(replace);
                            reveal();
                        }).catch(props.onError)
                            .finally(() => setLoading((current) => { const next = new Set(current); next.delete(item.path); return next; }));
                    }}
                    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', minHeight: 40, paddingLeft: 8 + Math.min(depth, 8) * 14, paddingRight: 12, backgroundColor: pressed || selected ? theme.colors.surfaceHighest : 'transparent' })}>
                    {isFolder && (busy ? <ActivityIndicator size="small" color={theme.colors.textSecondary} style={{ width: 12 }} /> : <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={12} color={theme.colors.textSecondary} />)}
                    {!isFolder && <View style={{ width: 12 }} />}
                    <MaterialCommunityIcons name={icon.name} size={ui.icon.row} color={selected ? theme.colors.accent : theme.colors.textSecondary} style={{ marginHorizontal: 6 }} />
                    <Text numberOfLines={1} style={{ color: selected ? theme.colors.accent : theme.colors.text, fontSize: 13.5, flex: 1 }}>{item.name}</Text>
                </Pressable>;
            })}
        </View>
    </View>;
}

/**
 * Label, number, bar, qualifier. A ranked series, a gauge and a ring all reduce
 * to this, which is why a phone can decline three desktop chart shapes and lose
 * no information: an arc and a bar encode the same scalar, and a donut's legend
 * has to reprint every value anyway.
 */
function MeterRow({ item, ratio, emphasis, delay, hero }: { item: PluginChartItem; ratio: number; emphasis: number; delay: number; hero?: boolean }) {
    const { theme } = useUnistyles();
    return (
        <View>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', marginBottom: 5 }}>
                <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 13, flex: 1, marginRight: 12 }}>{item.label}</Text>
                <Text style={{ color: item.tone === undefined || item.tone === 'secondary' ? theme.colors.text : toneColor(theme, item.tone), fontSize: hero === true ? 20 : 12.5, letterSpacing: hero === true ? -0.4 : 0, ...Typography.mono('semiBold') }}>{chartValue(item)}</Text>
                {item.detail !== undefined && <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 11.5, marginLeft: 8, ...Typography.mono('regular') }}>{item.detail}</Text>}
            </View>
            <Meter ratio={ratio} emphasis={emphasis} delay={delay} />
        </View>
    );
}

function ScreenChart({ node, data, nested }: { node: PluginScreenChartNode; data: unknown; nested: boolean }) {
    const { theme } = useUnistyles();
    const reduceMotion = useReducedMotion();
    // The plugin declares what the number means; this decides what it can look
    // like at this width. An arc and a donut are dashboard shapes, and a phone
    // is not a dashboard.
    // ponytail: window width, not the card's. Plugin screens own the content
    // area today; measure the card with onLayout if one ever renders in a
    // narrow column on a wide screen.
    const wide = useWindowDimensions().width >= 700;
    const series = asChartSeries(resolvePath(data, node.path));
    const title = node.title === undefined ? undefined : bindText(resolvePluginText(node.title), data);
    const empty = node.emptyText === undefined ? t('plugins.nothingToShow') : bindText(resolvePluginText(node.emptyText), data);
    // Empty says so in one quiet line. A full card drawn around "nothing yet"
    // spends the same space as real data. Inside a section the owning title
    // already carries the context, so an empty chart leaves no trace at all.
    if (series.length === 0 && nested && title !== undefined) return null;
    if (series.length === 0) return <View style={{ marginBottom: nested ? 8 : 14 }}>
        {title !== undefined && <SectionLabel style={{ marginBottom: 4, marginTop: nested ? 10 : 0 }}>{title}</SectionLabel>}
        <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>{empty}</Text>
    </View>;
    const total = series.reduce((sum, item) => sum + item.value, 0);
    const summary = `${title ?? 'Chart'}: ${series.map((item) => `${item.label} ${node.variant === 'ring' ? `${Math.round(item.value / total * 100)} percent` : chartValue(item)}${item.detail === undefined ? '' : ` ${item.detail}`}`).join(', ')}`;
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
        return <View accessible accessibilityRole="progressbar" accessibilityLabel={summary}
            accessibilityValue={{ min: 0, max: 100, now: Math.round(ratio * 100) }} style={card}>
            {heading}
            {!wide && <MeterRow item={hero} ratio={ratio} emphasis={1} delay={0} hero />}
            {wide && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
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
            </View>}
        </View>;
    }

    // Time reads left to right. Ranking a series of days destroys the shape.
    if (node.variant === 'column') {
        const peak = Math.max(...series.map((item) => item.value));
        const last = series.length - 1;
        const peakIndex = series.findIndex((item) => item.value === peak);
        return <View accessible accessibilityRole="image" accessibilityLabel={summary} style={card}>
            {heading}
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: wide ? 104 : 64, gap: 6 }}>
                {series.map((item, index) => (
                    <View key={`${item.label}-${index}`} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
                        {(index === last || index === peakIndex) && <Text numberOfLines={1} style={{ color: index === last ? theme.colors.text : theme.colors.textSecondary, fontSize: 11, marginBottom: 4, ...Typography.mono('semiBold') }}>{chartValue(item)}</Text>}
                        <AnimatedColumn ratio={peak === 0 ? 0 : item.value / peak} delay={index * 45}
                            color={index === last ? theme.colors.accent : withAlpha(theme.colors.accent, 0.28)} track="transparent" />
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
        </View>;
    }
    if (node.variant === 'ring') {
        // First slice is the hero: its value/label sit in the donut center.
        const hero = series[0]!;
        const sliceColor = (item: PluginChartItem, index: number) => item.tone === 'secondary'
            ? theme.colors.surfaceHighest
            : item.tone !== undefined ? chartFill(theme, item.tone) : rampFill(theme, index, series.length);
        const slices = series.map((item, index) => ({ label: item.label, value: item.value, color: sliceColor(item, index) }));
        if (!wide) {
            // The remainder slice is exactly what the empty part of a meter
            // already draws, so used/left collapses to a single row.
            const parts = series.filter((item) => item.tone !== 'secondary');
            return <View accessible accessibilityRole="image" accessibilityLabel={summary} style={{ ...cardStyle(theme), marginBottom: 14, padding: 16 }}>
                {title !== undefined && <SectionLabel style={{ marginBottom: 12 }}>{title}</SectionLabel>}
                <View style={{ gap: 12 }}>
                    {parts.map((item, index) => (
                        <MeterRow key={`${item.label}-${index}`} item={item} ratio={total === 0 ? 0 : item.value / total}
                            emphasis={1 - index * 0.18} delay={index * 45} hero={parts.length === 1} />
                    ))}
                </View>
            </View>;
        }
        return <View accessible accessibilityRole="image" accessibilityLabel={summary}
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
            {series.length >= 3 && <View style={{ marginTop: 14 }}>
                {series.map((item, index) => (
                    <View key={`${item.label}-${index}-legend`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 }}>
                        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: sliceColor(item, index) }} />
                        <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.textSecondary, fontSize: 12 }}>{item.label}</Text>
                        <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 12, ...Typography.mono('regular') }}>{chartValue(item)}</Text>
                    </View>
                ))}
            </View>}
        </View>;
    }
    const max = Math.max(...series.map((item) => item.value));
    return <View style={card} accessible accessibilityRole="image" accessibilityLabel={summary}>
        {heading}
        <View style={{ gap: 12 }}>
            {series.map((item, index) => (
                <MeterRow key={`${item.label}-${index}`} item={item} ratio={max === 0 ? 0 : item.value / max}
                    emphasis={1 - index * 0.18} delay={index * 45} />
            ))}
        </View>
    </View>;
}

function ScreenTextField(props: { label: string; value: string; placeholder?: string; onChangeText: (next: string) => void }) {
    const { theme } = useUnistyles();
    const [focused, setFocused] = React.useState(false);
    return (
        <View style={{ paddingVertical: 8 }}>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginBottom: 6 }}>{props.label}</Text>
            <TextInput
                value={props.value}
                onChangeText={props.onChangeText}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                placeholder={props.placeholder}
                placeholderTextColor={theme.colors.textSecondary}
                maxLength={1024}
                accessibilityLabel={props.label}
                style={{
                    color: theme.colors.text, fontSize: 15, backgroundColor: theme.colors.surfaceHighest,
                    borderRadius: 12, borderWidth: 1, borderColor: focused ? theme.colors.accent : theme.colors.divider,
                    paddingHorizontal: 10, paddingVertical: 10,
                }}
            />
        </View>
    );
}

function ScreenButton(props: { node: PluginScreenButtonNode; label: string; running: boolean; onPress: () => void }) {
    const { theme } = useUnistyles();
    const reduceMotion = useReducedMotion();
    const scale = useSharedValue(1);
    const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
    const press = (to: number) => {
        if (reduceMotion) return;
        scale.value = withSpring(to, { damping: 20, stiffness: 380, mass: 0.5 });
    };
    // Danger uses the theme's error surface: a solid red fill with a white
    // label instead of the old red-on-red text-on-text.
    const variantColor = props.node.variant === 'danger'
        ? theme.colors.box.error.border
        : props.node.variant === 'primary' ? theme.colors.accent : theme.colors.surfaceHighest;
    const labelColor = props.node.variant === 'danger' ? '#fff' : props.node.variant === 'primary' ? theme.colors.button.primary.tint : theme.colors.text;
    return (
        <Animated.View style={animated}>
            <Pressable
                onPress={props.onPress}
                onPressIn={() => press(0.97)}
                onPressOut={() => press(1)}
                disabled={props.running}
                accessibilityRole="button"
                accessibilityLabel={props.label}
                accessibilityState={{ busy: props.running, disabled: props.running }}
                style={{ borderRadius: ui.radius.control, paddingVertical: 10, alignItems: 'center', backgroundColor: variantColor, borderWidth: props.node.variant === undefined || props.node.variant === 'secondary' ? StyleSheet.hairlineWidth : 0, borderColor: theme.colors.divider, marginVertical: 6, opacity: props.running ? 0.6 : 1 }}>
                {props.running ? <ActivityIndicator color={labelColor} /> : <Text style={{ color: labelColor, fontSize: 14, fontWeight: '600' }}>{props.label}</Text>}
            </Pressable>
        </Animated.View>
    );
}

function ScreenNode(props: {
    node: PluginScreenNode;
    data: unknown;
    fields: ScreenFieldValues;
    setField: (id: string, value: string | boolean) => void;
    running: boolean;
    onButton: (button: PluginScreenButtonNode) => void;
    onRowAction: (action: PluginScreenRowAction, item: unknown) => void;
    onTreeLoad: (node: PluginScreenTreeNode, path: string) => Promise<RuntimeTreeItem[]>;
    onTreeError: (error: unknown) => void;
    onSelectTab: (param: string, value: string) => void;
    /** Pending tab selections; the pressed pill highlights before its payload lands. */
    tabOverrides?: Record<string, string>;
    /** Inside a section, which already owns the card around this node. */
    nested?: boolean;
}) {
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    const { node, data, fields } = props;
    const bind = (value: PluginText) => bindText(resolvePluginText(value), data);
    switch (node.type) {
        case 'text':
            return <Text style={{ color: node.tone === undefined ? theme.colors.text : toneColor(theme, node.tone), fontSize: 15, lineHeight: 21, marginBottom: 8 }}>{bind(node.text)}</Text>;
        case 'row':
            return <ScreenRow row={node} data={data} onRowAction={props.onRowAction} insideCard={props.nested === true} style={{ paddingVertical: 10 }} />;
        case 'diff': {
            const patch = resolvePath(data, node.path);
            if (typeof patch !== 'string' || patch === '') return null;
            return <View style={{ marginBottom: 8 }}><PierreDiffView patch={boundText(patch, 600, 64 * 1024).text} diffStyle="unified" overflow="scroll" /></View>;
        }
        case 'code': {
            const source = resolvePath(data, node.path);
            if (typeof source !== 'string' || source === '') return null;
            const fileName = node.fileNamePath === undefined ? undefined : resolvePath(data, node.fileNamePath);
            return <SyntaxHighlightedCode code={sanitizeDisplayText(source).replace(/\r\n/g, '\n')} language={node.language}
                {...(typeof fileName === 'string' ? { fileName: capUtf8Bytes(sanitizeDisplayText(fileName), 160) } : {})} />;
        }
        case 'metric':
            return (
                <View style={{ paddingVertical: 10 }}>
                    <SectionLabel>{bind(node.label)}</SectionLabel>
                    <Text style={{ color: theme.colors.text, fontSize: 30, letterSpacing: -0.5, marginTop: 2, ...Typography.mono('semiBold') }}>{bind(node.value)}</Text>
                </View>
            );
        case 'badge':
            return (
                <View style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, marginBottom: 10, backgroundColor: withAlpha(theme.colors.accent, 0.08) }}>
                    {node.tone !== undefined && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: toneColor(theme, node.tone) }} />}
                    <Text style={{ color: theme.colors.text, fontSize: 12, ...Typography.mono('regular') }}>{bind(node.label)}</Text>
                </View>
            );
        case 'progress': {
            const max = node.max ?? 100;
            const resolved = node.path === undefined ? node.value : resolvePath(data, node.path);
            const raw = typeof resolved === 'number' && Number.isFinite(resolved) ? resolved : 0;
            const value = Math.max(0, Math.min(max, raw));
            const label = node.label === undefined ? undefined : bind(node.label);
            const valueLabel = node.valueLabel === undefined ? undefined : bind(node.valueLabel);
            return (
                <View style={{ marginBottom: 12 }} accessibilityRole="progressbar" accessibilityLabel={[label, valueLabel].filter(Boolean).join(', ') || undefined}
                    accessibilityValue={{ min: 0, max, now: value }}>
                    {(label !== undefined || valueLabel !== undefined) && <View style={{ flexDirection: 'row', marginBottom: 6 }}>
                        {label !== undefined && <Text style={{ color: theme.colors.text, fontSize: 13, flex: 1 }}>{label}</Text>}
                        {valueLabel !== undefined && <Text style={{ color: node.tone === undefined || node.tone === 'positive' ? theme.colors.textSecondary : toneColor(theme, node.tone), fontSize: 13, ...Typography.mono('regular') }}>{valueLabel}</Text>}
                    </View>}
                    <Meter ratio={max === 0 ? 0 : value / max} />
                </View>
            );
        }
        case 'chart':
            return <ScreenChart node={node} data={data} nested={props.nested === true} />;
        case 'divider':
            return <View style={{ height: 1, backgroundColor: theme.colors.divider, marginVertical: 12 }} />;
        case 'empty':
            return (
                <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                    {node.title !== undefined && <Text style={{ color: theme.colors.text, fontSize: 16, fontWeight: '600' }}>{bind(node.title)}</Text>}
                    {node.message !== undefined && <Text style={{ color: theme.colors.textSecondary, fontSize: 14, marginTop: 4, textAlign: 'center' }}>{bind(node.message)}</Text>}
                </View>
            );
        case 'section': {
            const columns = node.columns === 3 && width < 480 ? 2 : node.columns;
            // A section inside a section is a group, not a second card: stacking
            // panels inside panels is what turns a screen into a wall of boxes.
            const body = (
                <View style={props.nested
                    ? (columns === undefined ? {} : { flexDirection: 'row', flexWrap: 'wrap', columnGap: 10 })
                    : {
                        ...cardStyle(theme), paddingHorizontal: 16, paddingVertical: 12,
                        ...(columns === undefined ? {} : { flexDirection: 'row', flexWrap: 'wrap', columnGap: 10 }),
                    }}>
                    {node.children.map((child, index) => columns === undefined
                        ? <ScreenNode key={index} {...props} node={child} nested />
                        : <View key={index} style={{ flexBasis: `${100 / columns - 2}%`, flexGrow: 1, maxWidth: `${100 / columns}%` }}><ScreenNode {...props} node={child} nested /></View>)}
                </View>
            );
            return (
                <View style={{ marginBottom: props.nested ? 4 : 14 }}>
                    {node.title !== undefined && <SectionLabel style={{ marginBottom: 10, marginTop: props.nested ? 10 : 0 }}>{bind(node.title)}</SectionLabel>}
                    {body}
                </View>
            );
        }
        case 'tabs': {
            const tabs = asScreenTabs(resolvePath(data, node.path));
            if (tabs.length === 0) return null;
            const selected = props.tabOverrides?.[node.param] ?? resolvePath(data, node.selectedPath);
            const active = typeof selected === 'string' && selected !== '' ? selected : tabs[0]!.id;
            return (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }} contentContainerStyle={{ gap: 6, paddingRight: 24 }}>
                    {tabs.map((tab) => (
                        <Pressable key={tab.id} accessibilityRole="tab" accessibilityState={{ selected: tab.id === active }} accessibilityLabel={tab.label}
                            onPress={() => { hapticsSelection(); props.onSelectTab(node.param, tab.id); }}
                            style={({ pressed }) => ({
                                paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
                                borderWidth: StyleSheet.hairlineWidth,
                                borderColor: tab.id === active ? 'transparent' : theme.colors.divider,
                                backgroundColor: tab.id === active ? theme.colors.accent : pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh,
                            })}>
                            <Text style={{ fontSize: 13, fontWeight: '600', color: tab.id === active ? theme.colors.surface : theme.colors.textSecondary }}>{tab.label}</Text>
                        </Pressable>
                    ))}
                </ScrollView>
            );
        }
        case 'tree':
            return <ScreenTree node={node} data={data} fields={fields} setField={props.setField} onRowAction={props.onRowAction} onError={props.onTreeError}
                {...(node.source === undefined ? {} : { loadChildren: (path) => props.onTreeLoad(node, path) })} />;
        case 'list': {
            const repeated: { row: PluginScreenRowNode; item: unknown }[] = (() => {
                if (node.repeat === undefined) return [];
                const entries = resolvePath(data, node.repeat.path);
                if (!Array.isArray(entries)) return [];
                return entries.slice(0, MAX_SCREEN_LIST_ROWS).map((entry) => ({ row: node.repeat!.template, item: entry }));
            })();
            const all = [...node.rows.map((row) => ({ row, item: undefined as unknown })), ...repeated];
            return (
                <View style={{ marginBottom: props.nested ? 4 : 14 }}>
                    {node.title !== undefined && <SectionLabel style={{ marginBottom: 10, marginTop: props.nested ? 10 : 0 }}>{bind(node.title)}</SectionLabel>}
                    <View style={props.nested ? {} : { ...cardStyle(theme), paddingHorizontal: 16, paddingVertical: 4 }}>
                        {all.length === 0
                            ? <Text style={{ color: theme.colors.textSecondary, fontSize: 13, paddingVertical: 10 }}>{bind(node.emptyText ?? t('plugins.nothingToShow'))}</Text>
                            : all.map(({ row, item }, index) => (
                                <ScreenRow key={index} row={row} data={data} item={item} onRowAction={props.onRowAction} insideCard
                                    style={{ paddingVertical: 9, borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider }} />
                            ))}
                    </View>
                </View>
            );
        }
        case 'field': {
            const value = fields[node.id];
            const set = (next: string | boolean) => props.setField(node.id, next);
            if (node.kind === 'switch') {
                return (
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 }}>
                        <Text style={{ color: theme.colors.text, fontSize: 15, flex: 1 }}>{bind(node.label)}</Text>
                        <Switch value={value === true} onValueChange={set} accessibilityLabel={bind(node.label)} />
                    </View>
                );
            }
            if (node.kind === 'select') {
                return (
                    <View style={{ paddingVertical: 8 }}>
                        <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginBottom: 6 }}>{bind(node.label)}</Text>
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                            {(node.options ?? []).map((option) => {
                                const optionValue = defaultPluginText(option);
                                const selected = value === optionValue;
                                return (
                                    <Pressable key={optionValue} onPress={() => { hapticsSelection(); set(optionValue); }} accessibilityRole="button" accessibilityState={{ selected }}
                                        hitSlop={8}
                                        style={({ pressed }) => ({ borderRadius: 999, paddingHorizontal: 14, minHeight: 34, justifyContent: 'center', backgroundColor: selected ? theme.colors.accent : pressed ? theme.colors.surfacePressed : theme.colors.surfaceHighest })}>
                                        <Text style={{ color: selected ? theme.colors.button.primary.tint : theme.colors.text, fontSize: 14 }}>{resolvePluginText(option)}</Text>
                                    </Pressable>
                                );
                            })}
                        </View>
                    </View>
                );
            }
            return <ScreenTextField label={bind(node.label)} value={typeof value === 'string' ? value : ''} onChangeText={set}
                {...(node.placeholder === undefined ? {} : { placeholder: bind(node.placeholder) })} />;
        }
        case 'button':
            return <ScreenButton node={node} label={bind(node.label)} running={props.running} onPress={() => props.onButton(node)} />;
    }
}

/** Stable across key order so a tab revisit hits the same cache entry. */
function paramsKey(params: Record<string, string> | undefined): string {
    return params === undefined ? '' : JSON.stringify(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
}

function sourceLabel(source: PluginSource): string {
    if (source.kind === 'github') {
        const owner = source.owner ?? 'unknown';
        const repo = source.repo ?? 'unknown';
        return `github:${owner}/${repo}`;
    }
    if (source.kind === 'npm') return `npm:${source.name}@${source.version}`;
    return 'local';
}

function ScreenBody(props: {
    screen: PluginScreenContribution;
    manifest: PluginManifestV1;
    pluginId: string;
    manifestHash: string;
    pluginName: string;
    source: PluginSource;
    /** Params passed by a row action; they become the data RPC input. */
    params?: Record<string, string>;
}) {
    const { screen } = props;
    const router = useRouter();
    const dataContributionId = screen.data?.contributionId;
    // A pressed tab is just another screen param, so one payload per tab keeps
    // the plugin's reply small instead of shipping every tab's detail at once.
    const [tabParams, setTabParams] = React.useState<Record<string, string>>({});
    const callParams = React.useMemo(() => {
        const merged = { ...(props.params ?? {}), ...tabParams };
        return Object.keys(merged).length === 0 ? undefined : merged;
    }, [props.params, tabParams]);
    const cacheKey = React.useMemo(() => dataContributionId === undefined
        ? undefined
        : `${props.pluginId}:${props.manifestHash}:${dataContributionId}:${paramsKey(callParams)}`,
    [callParams, dataContributionId, props.manifestHash, props.pluginId]);
    const [data, setData] = React.useState<unknown>(() => cacheKey === undefined ? undefined : screenCache.get(cacheKey));
    const [dataError, setDataError] = React.useState<string>();
    const [fields, setFields] = React.useState<ScreenFieldValues>(() => initialFieldValues(screen));
    const [running, setRunning] = React.useState(false);
    const [status, setStatus] = React.useState<{ ok: boolean; text: string }>();
    const [refreshNonce, setRefreshNonce] = React.useState(0);
    const [loading, setLoading] = React.useState(dataContributionId !== undefined);
    const [refreshing, setRefreshing] = React.useState(false);
    const operationVersion = React.useRef(0);
    const dirtyFields = React.useRef(new Set<string>());
    const writeKeys = sharedPluginWriteKeys;
    const request = React.useCallback((type: 'plugin.call', params: RequestParams<'plugin.call'>): Promise<unknown> => sync.request(type, params, PLUGIN_CALL_CLIENT_TIMEOUT_MS), []);
    React.useEffect(() => {
        operationVersion.current += 1;
        dirtyFields.current.clear();
        setRunning(false);
        setTabParams({});
        return () => { operationVersion.current += 1; };
    }, [props.manifest, props.manifestHash, props.params]);
    React.useEffect(() => subscribePluginDataInvalidation(props.pluginId, () => {
        if (dataContributionId !== undefined) setRefreshNonce((value) => value + 1);
    }), [dataContributionId, props.pluginId]);
    React.useEffect(() => {
        if (dataContributionId === undefined || cacheKey === undefined) return;
        let cancelled = false;
        // Stale first, fresh behind it: a reopened screen never starts blank.
        const cached = screenCache.get(cacheKey);
        if (cached !== undefined) setData(cached);
        setLoading(true);
        setDataError(undefined);
        void loadScreenData(dataContributionId, props.manifest, props.pluginId, props.manifestHash, request, callParams)
            .then((value) => {
                if (cancelled) return;
                screenCache.set(cacheKey, value);
                setData(value);
                const defaults = initialFieldValues(screen, value);
                setFields((current) => Object.fromEntries(Object.entries(defaults).map(([id, initial]) =>
                    [id, dirtyFields.current.has(id) ? current[id] ?? initial : initial])));
            })
            .catch((error: unknown) => { if (!cancelled) setDataError(error instanceof Error ? error.message : String(error)); })
            .finally(() => { if (!cancelled) { setLoading(false); setRefreshing(false); } });
        return () => { cancelled = true; };
    }, [cacheKey, dataContributionId, props.manifest, props.pluginId, props.manifestHash, callParams, request, refreshNonce]);

    const onRowAction = React.useCallback((action: PluginScreenRowAction, item: unknown) => {
        const bound = action.type === 'screen' && action.params !== undefined
            ? { ...action, params: Object.fromEntries(Object.entries(action.params).map(([key, value]) => [key, bindText(value, data, item)])) }
            : action;
        void dispatchPluginAction(bound, {
            router, pluginId: props.pluginId, manifestHash: props.manifestHash, manifest: props.manifest,
        }).catch((error: unknown) => setStatus({ ok: false, text: error instanceof Error ? error.message : String(error) }));
    }, [router, data, props.pluginId, props.manifestHash, props.manifest, props.params]);

    const onButton = React.useCallback((button: PluginScreenButtonNode) => {
        const version = operationVersion.current;
        setRunning(true);
        setStatus(undefined);
        if (button.action.type !== 'plugin.call') {
            void dispatchPluginAction(button.action, {
                router, pluginId: props.pluginId, manifestHash: props.manifestHash, manifest: props.manifest,
            }).then((result) => {
                if (version !== operationVersion.current || typeof result === 'object' && result !== null && 'cancelled' in result) return;
                hapticsSuccess();
                setStatus({ ok: true, text: t('inbox.reason.done') });
                if (shouldReloadAfterAction(props.manifest, button.action, true)) setRefreshNonce((value) => value + 1);
            }).catch((error: unknown) => {
                if (version !== operationVersion.current) return;
                hapticsError();
                setStatus({ ok: false, text: error instanceof Error ? error.message : String(error) });
            }).finally(() => setRunning(false));
            return;
        }
        // The retained write key is scoped to this contribution+manifest, so a
        // duplicate press with unchanged input reuses it (host replay-fences).
        const slot = `${props.pluginId}:${props.manifestHash}:${button.action.contributionId}`;
        void runScreenButton({
            button, fields, pluginId: props.pluginId, manifestHash: props.manifestHash,
            manifest: props.manifest, writeKeys,
            ...(callParams === undefined ? {} : { params: callParams }),
            slot, newIdempotencyKey: () => newIdempotencyKey(),
        }, request).then((outcome) => {
            setRunning(false);
            if (version !== operationVersion.current) return;
            if (outcome.ok) hapticsSuccess(); else hapticsError();
            setStatus(outcome);
            if (shouldReloadAfterAction(props.manifest, button.action, outcome.ok)) setRefreshNonce((value) => value + 1);
        });
    }, [fields, props.pluginId, props.manifestHash, props.manifest, callParams, request, router, writeKeys]);

    const setField = React.useCallback((id: string, value: string | boolean) => {
        dirtyFields.current.add(id);
        setFields((current) => ({ ...current, [id]: value }));
    }, []);
    const onTreeLoad = React.useCallback(async (node: PluginScreenTreeNode, path: string): Promise<RuntimeTreeItem[]> => {
        if (node.source === undefined) return [];
        const value = await loadScreenData(
            node.source.contributionId,
            props.manifest,
            props.pluginId,
            props.manifestHash,
            request,
            { ...(callParams ?? {}), path },
        );
        return asScreenTree(resolvePath(value, node.path));
    }, [props.manifest, props.manifestHash, callParams, props.pluginId, request]);

    const { theme } = useUnistyles();
    const reduceMotion = useReducedMotion();
    // A reload keeps the last payload on screen: blanking to a spinner costs the
    // reader their place and re-runs the entrance on every tab tap.
    const hasContent = dataContributionId === undefined || data !== undefined || dataError !== undefined;
    return (
        <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface }} contentContainerStyle={{ padding: 14, paddingTop: 10, paddingBottom: 40 }}
            refreshControl={dataContributionId === undefined ? undefined : (
                <RefreshControl refreshing={refreshing} tintColor={theme.colors.textSecondary}
                    onRefresh={() => { setRefreshing(true); setRefreshNonce((value) => value + 1); }} />
            )}>
            <LoadingHairline active={loading} />
            {screen.title !== undefined && <Text style={{ color: theme.colors.text, fontSize: 21, fontWeight: '700', marginBottom: 8 }}>{bindText(resolvePluginText(screen.title), data)}</Text>}
            {/* Show why, not just that: a plugin author debugging a screen has
                nothing to go on otherwise. The host already bounds this text. */}
            {dataError !== undefined && <Pressable onPress={() => setRefreshNonce((value) => value + 1)} accessibilityRole="button" accessibilityLabel={`${capUtf8Bytes(sanitizeDisplayText(dataError), 300)}. ${t('plugins.retry')}`} style={{ marginBottom: 8, paddingVertical: 10 }}>
                <Text style={{ color: theme.colors.box.error.text, fontSize: 13 }}>{capUtf8Bytes(sanitizeDisplayText(dataError), 300)}</Text>
                <Text style={{ color: theme.colors.textLink, fontSize: 13, marginTop: 4 }}>{t('plugins.retry')}</Text>
            </Pressable>}
            {hasContent
                ? <View style={{ opacity: loading ? 0.55 : 1 }}>
                    {screen.children.map((node, index) => (
                        <Animated.View key={index} entering={reduceMotion ? undefined : FadeInDown.duration(280).delay(Math.min(index, 8) * 40).easing(Easing.bezier(0.23, 1, 0.32, 1))}>
                            <ScreenNode node={node} data={data} fields={fields} setField={setField} running={running} onButton={onButton} onRowAction={onRowAction} onTreeLoad={onTreeLoad}
                                tabOverrides={tabParams}
                                onSelectTab={(param, value) => setTabParams((current) => ({ ...current, [param]: value }))}
                                onTreeError={(error) => setStatus({ ok: false, text: error instanceof Error ? error.message : String(error) })} />
                        </Animated.View>
                    ))}
                </View>
                : <ScreenSkeleton />}
            {status !== undefined && (
                <Text accessibilityLiveRegion="polite" accessibilityRole="alert"
                    style={{ color: status.ok ? theme.colors.success : theme.colors.box.error.text, fontSize: 13, marginTop: 10 }}>
                    {status.text}
                </Text>
            )}
            {/* Provenance is a footnote, not a headline: the screen's own title
                leads, and where the plugin came from waits at the bottom. */}
            {props.source.kind !== 'local' && <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 11, marginTop: 20 }}>{`${props.pluginName} · ${sourceLabel(props.source)}`}</Text>}
        </ScrollView>
    );
}

export function DeclarativeScreen({ contribution, pluginId, params }: { contribution: PluginScreenContribution; pluginId: string; params?: Record<string, string> }) {
    const entry = pluginSnapshot().find((candidate) => candidate.summary.pluginId === pluginId);
    if (entry === undefined) return null;
    return <ScreenBody screen={contribution} manifest={entry.manifest} pluginId={pluginId} manifestHash={entry.summary.manifestHash} pluginName={entry.summary.name} source={entry.summary.source} params={params} />;
}

export function newIdempotencyKey(): string {
    return randomUUID();
}
