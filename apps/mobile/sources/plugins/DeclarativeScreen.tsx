import * as React from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, FadeIn, FadeInDown, SlideInLeft, SlideInRight, cancelAnimation, runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withSpring, withTiming } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import type { PluginManifestV1, PluginScreenButtonNode, PluginScreenContribution, PluginScreenNode, PluginScreenRowAction, PluginScreenRowNode, PluginScreenTreeNode, PluginSource, PluginText, RequestParams } from '@muxr/contract';
import { MAX_SCREEN_LIST_ROWS, PLUGIN_CALL_CLIENT_TIMEOUT_MS, capUtf8Bytes, defaultPluginText, sanitizeDisplayText } from '@muxr/contract';
import { Switch } from '@/components/Switch';
import { hapticsError, hapticsSelection, hapticsSuccess } from '@/components/haptics';
import { NavigableDiff } from '@/components/diff/NavigableDiff';
import { SyntaxHighlightedCode } from '@/components/code/SyntaxHighlightedCode';
import { sync } from '@/sync/sync';
import { pluginSnapshot } from './pluginStore';
import { dispatchPluginAction } from './pluginActions';
import { clearPluginCache, registerPluginDataCacheInvalidator, subscribePluginDataInvalidation } from './pluginDataInvalidation';
import { toneColor } from './pluginTone';
import { bindText, initialFieldValues, loadScreenData, resolvePath, runScreenButton, sharedPluginWriteKeys, shouldReloadAfterAction, type ScreenFieldValues } from './screenModel';
import { resolvePluginText } from './pluginText';
import { asScreenTree, type RuntimeTreeItem } from './screenTreeModel';
import { fileIcon, folderIcon, type FileIcon } from './fileIcon';
import { t } from '@/text';
import { boundText } from '@/utils/boundedText';
import { Typography } from '@/constants/Typography';
import { cardStyle, Meter, SectionLabel, ui, withAlpha } from '@/components/ui';
import { DeclarativeScreenChart } from './DeclarativeScreenChart';

/** Screen payloads survive a close: reopening renders at once, then refreshes. */
const screenCache = new Map<string, unknown>();
registerPluginDataCacheInvalidator((pluginIds) => {
    if (pluginIds === undefined) screenCache.clear();
    else for (const pluginId of pluginIds) clearPluginCache(screenCache, pluginId);
});


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

/**
 * A repo tree on a phone is not an indented tree. Indentation spends the one
 * axis a phone does not have -- four levels deep leaves a third of the width
 * for the name -- and "expand all" on 1409 files is a scroll, not navigation.
 * So the phone does what Files and Working Copy do: one level at a time, a
 * breadcrumb back up, and the folder you are standing in is the folder you
 * picked.
 */
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
    const reduceMotion = useReducedMotion();
    const incoming = React.useMemo(() => asScreenTree(resolvePath(props.data, props.node.path)), [props.data, props.node.path]);
    const [items, setItems] = React.useState(incoming);
    const [stack, setStack] = React.useState<RuntimeTreeItem[]>([]);
    const [opening, setOpening] = React.useState<string | undefined>(undefined);
    const [descending, setDescending] = React.useState(true);
    const stackDepth = React.useRef(0);
    const trail = React.useRef<ScrollView>(null);
    const up = React.useCallback((depth: number) => {
        setDescending(false);
        setStack((current) => current.slice(0, depth));
    }, []);
    // Right-swipe pops a level, the way every pushed screen on this platform
    // behaves. Vertical intent belongs to the page, so the pan has to lose to it.
    const swipeBack = React.useMemo(() => Gesture.Pan().activeOffsetX(24).failOffsetY([-14, 14])
        .onEnd((event) => {
            if (event.translationX > 60) runOnJS(up)(Math.max(0, stackDepth.current - 1));
        }), [up]);
    React.useEffect(() => setItems(incoming), [incoming]);
    React.useEffect(() => setStack([]), [props.node.path]);

    // The stack holds snapshots, so a lazy load has to be re-read from the tree
    // it landed in or the level you are standing on stays empty.
    const findByPath = React.useCallback((nodes: RuntimeTreeItem[], path: string): RuntimeTreeItem | undefined => {
        for (const node of nodes) {
            if (node.path === path) return node;
            const found = findByPath(node.children, path);
            if (found !== undefined) return found;
        }
        return undefined;
    }, []);
    stackDepth.current = stack.length;
    const here = stack.length === 0 ? undefined : findByPath(items, stack[stack.length - 1]!.path) ?? stack[stack.length - 1]!;
    // Folders first, then the given order: every file browser a phone owner has
    // ever used puts the ways deeper above the leaves.
    const rows = React.useMemo(() => {
        const level = here === undefined ? items : here.children;
        return [...level].sort((left, right) => Number(right.kind === 'folder') - Number(left.kind === 'folder'));
    }, [here, items]);
    const title = props.node.title === undefined ? undefined : bindText(resolvePluginText(props.node.title), props.data);
    const enter = reduceMotion ? FadeIn.duration(120) : (descending ? SlideInRight : SlideInLeft).duration(200).easing(Easing.bezier(0.23, 1, 0.32, 1).factory());

    const open = (item: RuntimeTreeItem) => {
        if (props.node.selectionField !== undefined) props.setField(props.node.selectionField, item.path);
        const push = () => { setDescending(true); setStack((current) => [...current, item]); };
        if (item.children.length > 0 || !item.hasChildren || props.loadChildren === undefined) {
            push();
            return;
        }
        setOpening(item.path);
        void props.loadChildren(item.path).then((children) => {
            const replace = (nodes: RuntimeTreeItem[]): RuntimeTreeItem[] => nodes.map((candidate) =>
                candidate.path === item.path ? { ...candidate, children, hasChildren: children.length > 0 }
                    : { ...candidate, children: replace(candidate.children) });
            setItems(replace);
            push();
        }).catch(props.onError).finally(() => setOpening(undefined));
    };

    return <View style={{ marginBottom: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 32, marginBottom: 8 }}>
            {stack.length > 0 && (
                <Pressable onPress={() => up(stack.length - 1)}
                    accessibilityRole="button" accessibilityLabel="Back to parent folder" hitSlop={12}
                    style={({ pressed }) => ({ paddingRight: 6, opacity: pressed ? 0.6 : 1 })}>
                    <Ionicons name="chevron-back" size={16} color={theme.colors.textSecondary} />
                </Pressable>
            )}
            {stack.length === 0
                ? title !== undefined && <SectionLabel style={{ flex: 1 }}>{title}</SectionLabel>
                : <ScrollView ref={trail} horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={{ alignItems: 'center' }}
                    onContentSizeChange={() => trail.current?.scrollToEnd({ animated: true })}>
                    {/* The root keeps its name in the trail: three folders deep,
                        "which repo is this" is the question you cannot answer
                        from a list of leaf names. */}
                    <Pressable onPress={() => up(0)} hitSlop={10}
                        accessibilityRole="button" accessibilityLabel={`Go to ${title ?? 'root'}`}>
                        <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 12, ...Typography.mono('regular') }}>{title ?? 'root'}</Text>
                    </Pressable>
                    {stack.map((crumb, index) => (
                        // The separator is its own element: a slash padded with
                        // spaces inside the label collapses on web and leaves
                        // "apps/ mobile", which reads as a typo.
                        <React.Fragment key={crumb.path}>
                            <Text style={{ color: withAlpha(theme.colors.textSecondary, 0.45), fontSize: 12, paddingHorizontal: 6, ...Typography.mono('regular') }}>/</Text>
                            <Pressable onPress={() => up(index + 1)} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Go to ${crumb.name}`}>
                                <Text numberOfLines={1} style={{ color: index === stack.length - 1 ? theme.colors.text : theme.colors.textSecondary, fontSize: 12, ...Typography.mono('regular') }}>{crumb.name}</Text>
                            </Pressable>
                        </React.Fragment>
                    ))}
                </ScrollView>}
        </View>
        <GestureDetector gesture={swipeBack}>
        <View style={{ ...cardStyle(theme), paddingVertical: 4, overflow: 'hidden' }}>
            <Animated.View key={here?.path ?? '/'} entering={enter}>
                {rows.length === 0 ? <Text style={{ color: theme.colors.textSecondary, fontSize: 13, padding: 14 }}>
                    {props.node.emptyText === undefined ? t('plugins.nothingToShow') : bindText(resolvePluginText(props.node.emptyText), props.data)}
                </Text> : rows.map((item) => {
                    const isFolder = item.kind === 'folder';
                    const busy = opening === item.path;
                    const selected = props.node.selectionField !== undefined && props.fields[props.node.selectionField] === item.path;
                    return <Pressable key={item.path} accessibilityRole="button" accessibilityState={{ selected }}
                        accessibilityLabel={`${isFolder ? 'Folder' : 'File'} ${item.name}`}
                        onPress={() => {
                            if (isFolder) { open(item); return; }
                            if (props.node.action !== undefined) props.onRowAction(props.node.action, item);
                        }}
                        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 14, backgroundColor: pressed || selected ? theme.colors.surfaceHighest : 'transparent' })}>
                        <MaterialCommunityIcons name={treeIcon(item, false).name} size={ui.icon.row} color={selected ? theme.colors.accent : theme.colors.textSecondary} />
                        <Text numberOfLines={1} style={{ color: selected ? theme.colors.accent : theme.colors.text, fontSize: 15, flex: 1 }}>{item.name}</Text>
                        {/* A count only appears once it is known: a folder that
                            has never been opened does not guess at its size. */}
                        {isFolder && !busy && item.children.length > 0 && (
                            <Text style={{ color: theme.colors.textSecondary, fontSize: 11.5, ...Typography.mono('regular') }}>{item.children.length}</Text>
                        )}
                        {busy && <ActivityIndicator size="small" color={theme.colors.textSecondary} />}
                        {isFolder && !busy && <Ionicons name="chevron-forward" size={13} color={withAlpha(theme.colors.textSecondary, 0.6)} />}
                    </Pressable>;
                })}
            </Animated.View>
        </View>
        </GestureDetector>
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
            return <View style={{ marginBottom: 10 }}><NavigableDiff patch={boundText(patch, 600, 64 * 1024).text} /></View>;
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
            if (typeof resolved !== 'number' || !Number.isFinite(resolved)) return null;
            const value = Math.max(0, Math.min(max, resolved));
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
            return <DeclarativeScreenChart node={node} data={data} nested={props.nested === true} />;
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
