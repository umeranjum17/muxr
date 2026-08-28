import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, FadeIn, SlideInLeft, SlideInRight, runOnJS, useReducedMotion } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import type { PluginScreenRowAction, PluginScreenTreeNode, PluginText } from '@muxr/contract';
import { bindText, resolvePath } from '../domain/screenModel';
import { resolvePluginText } from '../domain/pluginText';
import { asScreenTree, type RuntimeTreeItem } from '../domain/screenTreeModel';
import { fileIcon, folderIcon, type FileIcon } from '../domain/fileIcon';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { cardStyle, SectionLabel, ui, withAlpha } from '@/components/ui';
import type { ScreenFieldValues } from '../domain/screenModel';

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
export function ScreenTree(props: {
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
    const bind = (value: PluginText) => bindText(resolvePluginText(value), props.data);
    const title = props.node.title === undefined ? undefined : bind(props.node.title);
    const enter = reduceMotion
        ? FadeIn.duration(120)
        : (descending ? SlideInRight : SlideInLeft).duration(200).easing(Easing.bezier(0.23, 1, 0.32, 1).factory());

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

    const trailTitle = title ?? 'root';

    return (
        <View style={{ marginBottom: 14 }}>
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
                    : (
                        <ScrollView ref={trail} horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={{ alignItems: 'center' }}
                            onContentSizeChange={() => trail.current?.scrollToEnd({ animated: true })}>
                            {/* The root keeps its name in the trail: three folders deep,
                                "which repo is this" is the question you cannot answer
                                from a list of leaf names. */}
                            <Pressable onPress={() => up(0)} hitSlop={10}
                                accessibilityRole="button" accessibilityLabel={`Go to ${trailTitle}`}>
                                <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 12, ...Typography.mono('regular') }}>{trailTitle}</Text>
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
                        </ScrollView>
                    )}
            </View>
            <GestureDetector gesture={swipeBack}>
                <View style={{ ...cardStyle(theme), paddingVertical: 4, overflow: 'hidden' }}>
                    <Animated.View key={here?.path ?? '/'} entering={enter}>
                        {rows.length === 0 ? (
                            <Text style={{ color: theme.colors.textSecondary, fontSize: 13, padding: 14 }}>
                                {props.node.emptyText === undefined ? t('plugins.nothingToShow') : bind(props.node.emptyText)}
                            </Text>
                        ) : rows.map((item) => {
                            const isFolder = item.kind === 'folder';
                            const busy = opening === item.path;
                            const selected = props.node.selectionField !== undefined && props.fields[props.node.selectionField] === item.path;
                            return (
                                <Pressable key={item.path} accessibilityRole="button" accessibilityState={{ selected }}
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
                                </Pressable>
                            );
                        })}
                    </Animated.View>
                </View>
            </GestureDetector>
        </View>
    );
}
