import * as React from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, type LayoutChangeEvent, type RefreshControlProps, type NativeScrollEvent, type NativeSyntheticEvent, type StyleProp, type ViewStyle } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withSpring, withTiming } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import type { PluginManifestV1, PluginScreenButtonNode, PluginScreenContribution, PluginScreenNode, PluginScreenRowAction, PluginScreenRowNode, PluginScreenTreeNode, PluginSource, PluginText, RequestParams } from '@muxr/contract';
import { MAX_SCREEN_LIST_ROWS, PLUGIN_CALL_CLIENT_TIMEOUT_MS, capUtf8Bytes, defaultPluginText, sanitizeDisplayText } from '@muxr/contract';
import { Switch } from '@/components/Switch';
import { hapticsError, hapticsSelection, hapticsSuccess } from '@/components/haptics';
import { NavigableDiff } from '@/components/diff/NavigableDiff';
import { CodeCore, PLUGIN_CODE_MAX_CHARS, PLUGIN_CODE_MAX_LINES } from '@/components/code/CodeCore';
import { sync } from '@/catalog/sync';
import { pluginSnapshot } from '../application/pluginStore';
import { dispatchPluginAction } from '../application/pluginActions';
import { clearPluginCache, registerPluginDataCacheInvalidator, subscribePluginDataInvalidation } from '../application/pluginDataInvalidation';
import { toneColor } from '../domain/pluginTone';
import { asScreenTabs, bindText, bindTone, contentMountTitle, initialFieldValues, loadScreenData, resolvePath, runScreenButton, sharedPluginWriteKeys, shouldReloadAfterAction, type ScreenFieldValues } from '../domain/screenModel';
import { resolvePluginText } from '../domain/pluginText';
import { asScreenTree, type RuntimeTreeItem } from '../domain/screenTreeModel';
import { t } from '@/text';
import { boundText } from '@/utils/boundedText';
import { Typography } from '@/constants/Typography';
import { cardStyle, IconTile, Meter, Notice, SectionLabel, ui, withAlpha } from '@/components/ui';
import { layout } from '@/components/layout';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScreenWidthProvider, useScreenContentWidth } from './pluginScreenLayout';
import { AgentGlyph } from '@/components/AgentGlyph';
import { ScreenChart } from './screenCharts';
import { ScreenLimits } from './screenLimits';
import { ScreenTree } from './screenTree';

/** Screen payloads survive a close: reopening renders at once, then refreshes. */
const screenCache = new Map<string, unknown>();

/** A plugin may flag its payload as last-known data; the screen revalidates it. */
function isStalePayload(value: unknown): boolean {
    return typeof value === 'object' && value !== null && (value as { stale?: unknown }).stale === true;
}
registerPluginDataCacheInvalidator((pluginIds) => {
    if (pluginIds === undefined) screenCache.clear();
    else for (const pluginId of pluginIds) clearPluginCache(screenCache, pluginId);
});

/** Indeterminate 2px bar: says "working" without taking the content's place. */
function LoadingHairline({ active }: { active: boolean }) {
    const { theme } = useUnistyles();
    const reduceMotion = useReducedMotion();
    const width = useScreenContentWidth();
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

/**
 * The placeholder has the screen's shape: each declared block becomes a
 * block, so the content does not jump when the payload lands.
 */
function ScreenSkeleton({ nodes }: { nodes: PluginScreenNode[] }) {
    const { theme } = useUnistyles();
    const heights: number[] = [];
    for (const node of nodes) {
        if (heights.length >= 3) break;
        switch (node.type) {
            case 'section':
            case 'list': heights.push(120); break;
            case 'chart': heights.push(140); break;
            case 'tree': heights.push(200); break;
            case 'code': heights.push(240); break;
            case 'limits': heights.push(220); break;
            case 'tabs': heights.push(30); break;
            case 'text': heights.push(20); break;
            case 'badge': heights.push(24); break;
            case 'button': heights.push(40); break;
            default: break;
        }
    }
    if (heights.length === 0) heights.push(120);
    return (
        <View style={{ gap: 12, marginTop: 4 }}>
            {heights.map((height, index) => (
                <View key={index} style={{ height, borderRadius: 16, backgroundColor: theme.colors.surfaceHigh }} />
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
    const title = bind(row.title);
    // A row bound to an empty title is the screen's one conditional: gone.
    if (title === '') return null;
    const tone = bindTone(row, props.data, item);
    const action = row.action;
    const value = row.value === undefined ? undefined : bind(row.value);
    const meta = row.meta === undefined ? undefined : bind(row.meta);
    const body = (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, ...(row.icon === undefined ? {} : { minHeight: 44 }) }}>
            {row.icon !== undefined && <IconTile name={row.icon} />}
            <View style={{ flex: 1, minWidth: 0 }}>
                {/* Two lines is a subject line; past that a list of commits turns
                    into a wall and you can see four of them on a phone. */}
                <Text numberOfLines={2} style={{ color: theme.colors.text, fontSize: 15, lineHeight: 20, letterSpacing: -0.1 }}>{title}</Text>
                {/* subtitle is prose in words; meta is facts in figures. */}
                {row.subtitle !== undefined && <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 1 }}>{bind(row.subtitle)}</Text>}
                {meta !== undefined && meta !== '' && <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 11.5, lineHeight: 15, marginTop: 3, ...Typography.mono('regular') }}>{meta}</Text>}
            </View>
            {value !== undefined && value !== ''
                ? <Text numberOfLines={1} style={{ color: tone === undefined ? theme.colors.text : toneColor(theme, tone), fontSize: 13, maxWidth: '45%', ...Typography.mono('regular') }}>{value}</Text>
                : tone !== undefined
                    ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: toneColor(theme, tone) }} />
                    : null}
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
    let variantColor = theme.colors.surfaceHighest;
    let labelColor = theme.colors.text;
    let bordered = true;
    if (props.node.variant === 'danger') {
        variantColor = theme.colors.box.error.border;
        labelColor = '#fff';
        bordered = false;
    } else if (props.node.variant === 'primary') {
        variantColor = theme.colors.accent;
        labelColor = theme.colors.button.primary.tint;
        bordered = false;
    }
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
                style={{ borderRadius: ui.radius.control, paddingVertical: 10, alignItems: 'center', backgroundColor: variantColor, borderWidth: bordered ? StyleSheet.hairlineWidth : 0, borderColor: theme.colors.divider, marginVertical: 6, opacity: props.running ? 0.6 : 1 }}>
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
    /**
     * Handed to a `viewport: 'fill'` code node, which is the screen's only
     * scroller once the screen has stopped being one.
     */
    refreshControl?: React.ReactElement<RefreshControlProps>;
}) {
    const { theme } = useUnistyles();
    const width = useScreenContentWidth();
    const { node, data, fields } = props;
    const bind = (value: PluginText) => bindText(resolvePluginText(value), data);
    switch (node.type) {
        case 'text': {
            const text = bind(node.text);
            if (text === '') return null;
            const tone = bindTone(node, data);
            // A toned sentence is a notice; secondary is a note. The author
            // picks the word, the renderer picks the voice.
            if (tone === 'positive' || tone === 'warning' || tone === 'danger') {
                return <Notice tone={tone} text={text} />;
            }
            if (tone === 'secondary') {
                return <Text style={{ color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18, marginBottom: 8 }}>{text}</Text>;
            }
            return <Text style={{ color: tone === undefined ? theme.colors.text : toneColor(theme, tone), fontSize: 15, lineHeight: 21, marginBottom: 8 }}>{text}</Text>;
        }
        case 'row':
            return <ScreenRow row={node} data={data} onRowAction={props.onRowAction} insideCard={props.nested === true} style={{ paddingVertical: 10 }} />;
        case 'diff': {
            const patch = resolvePath(data, node.path);
            if (typeof patch !== 'string' || patch === '') return null;
            return <View style={{ marginBottom: 10 }}><NavigableDiff patch={boundText(patch, PLUGIN_CODE_MAX_LINES, PLUGIN_CODE_MAX_CHARS).text} /></View>;
        }
        case 'code': {
            const source = resolvePath(data, node.path);
            const fill = node.viewport === 'fill';
            const named = node.fileNamePath === undefined ? undefined : resolvePath(data, node.fileNamePath);
            const titled = typeof named === 'string' ? { fileName: capUtf8Bytes(sanitizeDisplayText(named), 160) } : {};
            // An empty excerpt is nothing to show. An empty file still owns the
            // screen's only scroller, and rendering nothing would take the pull
            // that reloads it away with it.
            if (typeof source !== 'string' || source === '') {
                if (!fill) return null;
                return <CodeCore code="" language={node.language} header fill
                    maxLines={PLUGIN_CODE_MAX_LINES} maxChars={PLUGIN_CODE_MAX_CHARS}
                    {...titled}
                    {...(props.refreshControl === undefined ? {} : { refreshControl: props.refreshControl })} />;
            }
            return <CodeCore code={sanitizeDisplayText(source).replace(/\r\n/g, '\n')} language={node.language} header
                maxLines={PLUGIN_CODE_MAX_LINES} maxChars={PLUGIN_CODE_MAX_CHARS}
                {...(fill ? { fill: true } : {})}
                {...(fill && props.refreshControl !== undefined ? { refreshControl: props.refreshControl } : {})}
                {...titled} />;
        }
        case 'metric': {
            const value = bind(node.value);
            const blank = value === '';
            // A missing figure is information, not a hole: an em dash.
            return (
                <View style={{ paddingVertical: 10 }}>
                    <SectionLabel>{bind(node.label)}</SectionLabel>
                    <Text style={{ color: blank ? theme.colors.textSecondary : theme.colors.text, fontSize: 30, letterSpacing: -0.5, marginTop: 2, ...Typography.mono('semiBold') }}>{blank ? '—' : value}</Text>
                </View>
            );
        }
        case 'badge': {
            const label = bind(node.label);
            if (label === '') return null;
            const tone = bindTone(node, data);
            return (
                <View style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, marginBottom: 10, backgroundColor: withAlpha(theme.colors.accent, 0.08) }}>
                    {tone !== undefined && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: toneColor(theme, tone) }} />}
                    <Text style={{ color: theme.colors.text, fontSize: 12, ...Typography.mono('regular') }}>{label}</Text>
                </View>
            );
        }
        case 'progress': {
            const max = node.max ?? 100;
            const resolved = node.path === undefined ? node.value : resolvePath(data, node.path);
            if (typeof resolved !== 'number' || !Number.isFinite(resolved)) return null;
            const value = Math.max(0, Math.min(max, resolved));
            const label = node.label === undefined ? undefined : bind(node.label);
            const valueLabel = node.valueLabel === undefined ? undefined : bind(node.valueLabel);
            const tone = bindTone(node, data);
            return (
                <View style={{ marginBottom: 12 }} accessibilityRole="progressbar" accessibilityLabel={[label, valueLabel].filter(Boolean).join(', ') || undefined}
                    accessibilityValue={{ min: 0, max, now: value }}>
                    {(label !== undefined || valueLabel !== undefined) && <View style={{ flexDirection: 'row', marginBottom: 6 }}>
                        {label !== undefined && <Text style={{ color: theme.colors.text, fontSize: 13, flex: 1 }}>{label}</Text>}
                        {valueLabel !== undefined && <Text style={{ color: tone === undefined || tone === 'positive' ? theme.colors.textSecondary : toneColor(theme, tone), fontSize: 13, ...Typography.mono('regular') }}>{valueLabel}</Text>}
                    </View>}
                    <Meter ratio={max === 0 ? 0 : value / max} />
                </View>
            );
        }
        case 'limits':
            return <ScreenLimits node={node} data={data} />;
        case 'chart':
            return <ScreenChart node={node} data={data} nested={props.nested === true} />;
        case 'divider':
            return <View style={{ height: 1, backgroundColor: theme.colors.divider, marginVertical: 12 }} />;
        case 'empty': {
            const title = node.title === undefined ? '' : bind(node.title);
            const message = node.message === undefined ? '' : bind(node.message);
            if (title === '' && message === '') return null;
            return (
                <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                    {title !== '' && <Text style={{ color: theme.colors.text, fontSize: 16, fontWeight: '600' }}>{title}</Text>}
                    {message !== '' && <Text style={{ color: theme.colors.textSecondary, fontSize: 14, marginTop: 4, textAlign: 'center' }}>{message}</Text>}
                </View>
            );
        }
        case 'section': {
            const columns = node.columns === undefined
                ? undefined
                : Math.max(1, Math.min(node.columns, Math.floor((width + 10) / 160)));
            // A section inside a section is a group, not a second card: stacking
            // panels inside panels is what turns a screen into a wall of boxes.
            const body = (
                <View style={props.nested
                    ? (columns === undefined ? {} : { flexDirection: 'row', flexWrap: 'wrap', columnGap: 10 })
                    : {
                        ...cardStyle(theme), paddingHorizontal: 16, paddingVertical: 12,
                        ...(columns === undefined ? {} : { flexDirection: 'row', flexWrap: 'wrap', columnGap: 10 }),
                    }}>
                    {(() => {
                        let prevWasRow = false;
                        return node.children.map((child, index) => {
                            if (child.type === 'row' && bind(child.title) === '') return null;
                            if (columns !== undefined) {
                                prevWasRow = child.type === 'row';
                                return <View key={index} style={{ flexBasis: `${100 / columns - 2}%`, flexGrow: 1, maxWidth: `${100 / columns}%` }}><ScreenNode {...props} node={child} nested /></View>;
                            }
                            // Adjacent rows read as one table: hairlines between them.
                            const separated = child.type === 'row' && prevWasRow;
                            prevWasRow = child.type === 'row';
                            if (!separated) return <ScreenNode key={index} {...props} node={child} nested />;
                            return (
                                <View key={index} style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider }}>
                                    <ScreenNode {...props} node={child} nested />
                                </View>
                            );
                        });
                    })()}
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
                    {tabs.map((tab) => {
                        const labelColor = tab.id === active ? theme.colors.surface : theme.colors.textSecondary;
                        return (
                            <Pressable key={tab.id} accessibilityRole="tab" accessibilityState={{ selected: tab.id === active }} accessibilityLabel={tab.label}
                                onPress={() => { hapticsSelection(); props.onSelectTab(node.param, tab.id); }}
                                style={({ pressed }) => ({
                                    flexDirection: 'row', alignItems: 'center', gap: 6,
                                    paddingLeft: tab.glyph === undefined ? 12 : 10, paddingRight: 12, paddingVertical: 7, borderRadius: 999,
                                    borderWidth: StyleSheet.hairlineWidth,
                                    borderColor: tab.id === active ? 'transparent' : theme.colors.divider,
                                    backgroundColor: tab.id === active ? theme.colors.accent : pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh,
                                })}>
                                {tab.glyph !== undefined && (
                                    <AgentGlyph name={tab.glyph} size={16} color={labelColor} />
                                )}
                                <Text style={{ fontSize: 13, fontWeight: '600', color: labelColor }}>{tab.label}</Text>
                            </Pressable>
                        );
                    })}
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
            const visibleAll = all.filter(({ row, item }) => bindText(resolvePluginText(row.title), data, item) !== '');
            return (
                <View style={{ marginBottom: props.nested ? 4 : 14 }}>
                    {node.title !== undefined && <SectionLabel style={{ marginBottom: 10, marginTop: props.nested ? 10 : 0 }}>{bind(node.title)}</SectionLabel>}
                    <View style={props.nested ? {} : { ...cardStyle(theme), paddingHorizontal: 16, paddingVertical: 4 }}>
                        {visibleAll.length === 0
                            ? <Text style={{ color: theme.colors.textSecondary, fontSize: 13, paddingVertical: 10 }}>{bind(node.emptyText ?? t('plugins.nothingToShow'))}</Text>
                            : visibleAll.map(({ row, item }, index) => (
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
    /** The page header title; an in-body title resolving to this is dropped. */
    headerTitle: string;
    /** Params passed by a row action; they become the data RPC input. */
    params?: Record<string, string>;
    topContentInset?: number;
    bottomContentInset?: number;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}) {
    const { screen } = props;
    const safeArea = useSafeAreaInsets();
    const [contentWidth, setContentWidth] = React.useState<number>();
    const handleContentLayout = React.useCallback((event: LayoutChangeEvent) => {
        setContentWidth(Math.max(0, event.nativeEvent.layout.width - 28));
    }, []);
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
    // The payload carries the key it was fetched for. A tab tap changes the key
    // during render, so pairing them is what keeps the previous provider's
    // totals from being committed for a frame under the new provider's name.
    const [fetched, setFetched] = React.useState<{ key: string | undefined; value: unknown }>(() => ({ key: cacheKey, value: cacheKey === undefined ? undefined : screenCache.get(cacheKey) }));
    const data = fetched.key === cacheKey ? fetched.value : cacheKey === undefined ? undefined : screenCache.get(cacheKey);
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
        // Another tab's payload is not stale data for this one, though: keeping
        // it on screen would label one provider's totals with another's name.
        setLoading(true);
        setDataError(undefined);
        const load = (revalidate?: boolean) => loadScreenData(
            dataContributionId, props.manifest, props.pluginId, props.manifestHash, request,
            revalidate ? { ...(callParams ?? {}), _refresh: true } : callParams,
        );
        const apply = (value: unknown) => {
            screenCache.set(cacheKey, value);
            setFetched({ key: cacheKey, value });
            const defaults = initialFieldValues(screen, value);
            setFields((current) => Object.fromEntries(Object.entries(defaults).map(([id, initial]) =>
                [id, dirtyFields.current.has(id) ? current[id] ?? initial : initial])));
        };
        void load()
            .then((value) => {
                if (cancelled) return;
                apply(value);
                // Last-known numbers paint at once; a payload flagged stale by
                // the plugin revalidates quietly once -- asking for fresh data
                // by name -- and swaps in place. The revalidation never
                // chains, however stale the answer is.
                if (!isStalePayload(value)) return;
                void load(true).then((fresh) => {
                    if (!cancelled && fresh !== undefined) apply(fresh);
                }).catch(() => { /* the painted payload stands until a manual refresh */ });
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
    // The in-body title carries data (a file name, a commit subject); when it
    // resolves to the header string it is a duplicate, not information.
    const boundTitle = screen.title === undefined ? undefined : bindText(resolvePluginText(screen.title), data);
    // Adjacent top-level rows share one card with hairlines, exactly as a
    // list draws them: two facts stop floating between text and buttons.
    const topLevelNodes = (): React.ReactNode[] => {
        const renderNode = (node: PluginScreenNode, index: number): React.ReactNode => (
            <ScreenNode key={index} node={node} data={data} fields={fields} setField={setField} running={running} onButton={onButton} onRowAction={onRowAction} onTreeLoad={onTreeLoad}
                {...(refreshControl === undefined ? {} : { refreshControl })}
                tabOverrides={tabParams}
                onSelectTab={(param, value) => setTabParams((current) => ({ ...current, [param]: value }))}
                onTreeError={(error) => setStatus({ ok: false, text: error instanceof Error ? error.message : String(error) })} />
        );
        const out: React.ReactNode[] = [];
        let run: { node: PluginScreenRowNode; index: number }[] = [];
        const flushRun = (): void => {
            if (run.length === 0) return;
            // Rows bound to nothing take no card with them.
            const visible = run.filter(({ node }) => bindText(resolvePluginText(node.title), data) !== '');
            run = [];
            if (visible.length === 0) return;
            out.push(
                <View key={visible[0]!.index} style={{ ...cardStyle(theme), paddingHorizontal: 16, paddingVertical: 4, marginBottom: 14 }}>
                    {visible.map(({ node, index }, runIndex) => (
                        <ScreenRow key={index} row={node} data={data} onRowAction={onRowAction} insideCard
                            style={{ paddingVertical: 10, borderTopWidth: runIndex === 0 ? 0 : StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider }} />
                    ))}
                </View>,
            );
        };
        screen.children.forEach((node, index) => {
            if (node.type === 'row') { run.push({ node, index }); return; }
            flushRun();
            out.push(renderNode(node, index));
        });
        flushRun();
        return out;
    };
    // A reload keeps the last payload on screen: blanking to a spinner costs the
    // reader their place and re-runs the entrance on every tab tap.
    const hasContent = dataContributionId === undefined || data !== undefined || dataError !== undefined;
    const refreshControl = dataContributionId === undefined ? undefined : (
        <RefreshControl refreshing={refreshing} tintColor={theme.colors.textSecondary}
            onRefresh={() => { setRefreshing(true); setRefreshNonce((value) => value + 1); }} />
    );
    // A node that fills the screen brings its own scroller, and two scrollers on
    // one axis mount every row of the inner one. The screen keeps its chrome and
    // stops scrolling; the node takes the height that is left.
    const filled = screen.children.some((node) => node.type === 'code' && node.viewport === 'fill');
    const Page = filled ? View : ScrollView;
    return (
        <Page
            style={{ flex: 1, backgroundColor: theme.colors.surface }}
            {...(filled ? {} : {
                contentContainerStyle: {
                    paddingTop: props.topContentInset ?? 0,
                    paddingBottom: safeArea.bottom + (props.bottomContentInset ?? 0),
                },
                onScroll: props.onScroll,
                scrollEventThrottle: 16,
                refreshControl,
            })}
        >
            <View
                onLayout={handleContentLayout}
                style={[
                    { width: '100%', maxWidth: layout.maxWidth, alignSelf: 'center', padding: 14, paddingTop: 10, paddingBottom: 40 },
                    filled ? { flex: 1, paddingTop: (props.topContentInset ?? 0) + 10, paddingBottom: safeArea.bottom + (props.bottomContentInset ?? 0) + 14 } : {},
                ]}
            >
                <ScreenWidthProvider width={contentWidth}>
                    <LoadingHairline active={loading} />
                    {boundTitle !== undefined && boundTitle !== '' && boundTitle !== props.headerTitle && <Text style={{ color: theme.colors.text, fontSize: 21, fontWeight: '700', marginBottom: 8 }}>{boundTitle}</Text>}
                    {dataError !== undefined && <Pressable onPress={() => setRefreshNonce((value) => value + 1)} accessibilityRole="button" accessibilityLabel={`${capUtf8Bytes(sanitizeDisplayText(dataError), 300)}. ${t('plugins.retry')}`} style={{ marginBottom: 8, paddingVertical: 10 }}>
                        <Notice tone="danger" text={capUtf8Bytes(sanitizeDisplayText(dataError), 300)} style={{ marginBottom: 0 }} />
                        <Text style={{ color: theme.colors.textLink, fontSize: 13, marginTop: 4, marginLeft: 14 }}>{t('plugins.retry')}</Text>
                    </Pressable>}
                    {hasContent
                        ? <View style={[{ opacity: loading ? 0.55 : 1 }, filled ? { flex: 1 } : {}]}>
                            {topLevelNodes()}
                        </View>
                        : <ScreenSkeleton nodes={screen.children} />}
                    {status !== undefined && (
                        <Text accessibilityLiveRegion="polite" accessibilityRole="alert"
                            style={{ color: status.ok ? theme.colors.success : theme.colors.box.error.text, fontSize: 13, marginTop: 10 }}>
                            {status.text}
                        </Text>
                    )}
                    {props.source.kind !== 'local' && (
                        <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 11, marginTop: 20 }}>
                            {`${props.pluginName} · ${sourceLabel(props.source)}`}
                        </Text>
                    )}
                </ScreenWidthProvider>
            </View>
        </Page>
    );
}

export function DeclarativeScreen({
    contribution,
    pluginId,
    params,
    topContentInset,
    bottomContentInset,
    onScroll,
}: {
    contribution: PluginScreenContribution;
    pluginId: string;
    params?: Record<string, string>;
    topContentInset?: number;
    bottomContentInset?: number;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}) {
    const entry = pluginSnapshot().find((candidate) => candidate.summary.pluginId === pluginId);
    if (entry === undefined) return null;
    return <ScreenBody
        screen={contribution}
        manifest={entry.manifest}
        pluginId={pluginId}
        manifestHash={entry.summary.manifestHash}
        pluginName={entry.summary.name}
        headerTitle={contentMountTitle(entry.manifest, contribution.id, entry.summary.name, resolvePluginText)}
        source={entry.summary.source}
        params={params}
        topContentInset={topContentInset}
        bottomContentInset={bottomContentInset}
        onScroll={onScroll}
    />;
}

export function newIdempotencyKey(): string {
    return randomUUID();
}
