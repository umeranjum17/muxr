import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import type { PluginManifestV1, PluginScreenButtonNode, PluginScreenContribution, PluginScreenNode, PluginScreenRowAction, PluginScreenRowNode, PluginScreenTreeNode, PluginSource, PluginText, RequestParams } from '@muxr/contract';
import { MAX_SCREEN_LIST_ROWS, PLUGIN_CALL_CLIENT_TIMEOUT_MS, capUtf8Bytes, defaultPluginText, sanitizeDisplayText } from '@muxr/contract';
import type { Theme } from '@/theme';
import { Switch } from '@/components/Switch';
import { PierreDiffView } from '@/components/diff/PierreDiffView';
import { SyntaxHighlightedCode } from '@/components/code/SyntaxHighlightedCode';
import { sync } from '@/sync/sync';
import { pluginSnapshot } from './pluginStore';
import { dispatchPluginAction } from './pluginActions';
import { subscribePluginDataInvalidation } from './pluginDataInvalidation';
import { bindText, initialFieldValues, loadScreenData, resolvePath, runScreenButton, sharedPluginWriteKeys, shouldReloadAfterAction, type ScreenFieldValues } from './screenModel';
import { resolvePluginText } from './pluginText';
import { asScreenTree, type RuntimeTreeItem } from './screenTreeModel';
import { t } from '@/text';
import { boundText } from '@/utils/boundedText';

function toneColor(theme: Theme, tone: string | undefined): string {
    switch (tone) {
        case 'positive': return theme.colors.success;
        case 'warning': return theme.colors.box.warning.text;
        case 'danger': return theme.colors.box.error.text;
        case 'secondary': return theme.colors.textSecondary;
        default: return theme.colors.text;
    }
}

function ScreenRow(props: {
    row: PluginScreenRowNode;
    data: unknown;
    item?: unknown;
    onRowAction: (action: PluginScreenRowAction, item: unknown) => void;
    style?: StyleProp<ViewStyle>;
}) {
    const { theme } = useUnistyles();
    const { row, item } = props;
    const bind = (value: PluginText) => bindText(resolvePluginText(value), props.data, item);
    const body = <>
        <Text style={{ color: theme.colors.text, fontSize: 15 }}>{bind(row.title)}</Text>
        {row.subtitle !== undefined && <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 2 }}>{bind(row.subtitle)}</Text>}
        {row.value !== undefined && <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 2 }}>{bind(row.value)}</Text>}
    </>;
    const action = row.action;
    // A row without an action stays non-interactive.
    if (action === undefined) return <View style={props.style}>{body}</View>;
    return (
        <Pressable onPress={() => props.onRowAction(action, item)} accessibilityRole="button" accessibilityLabel={bind(row.title)} style={props.style}>
            {body}
        </Pressable>
    );
}

function treeIcon(item: RuntimeTreeItem, expanded: boolean): React.ComponentProps<typeof Ionicons>['name'] {
    if (item.kind === 'folder') return expanded ? 'folder-open-outline' : 'folder-outline';
    if (/\.(png|jpe?g|gif|webp)$/i.test(item.name)) return 'image-outline';
    if (/\.(mp4|mov|webm|wav|mp3)$/i.test(item.name)) return 'play-circle-outline';
    if (/\.(ts|tsx|js|jsx|mjs|py|kt|swift|rs|go|java|c|cpp|h)$/i.test(item.name)) return 'code-slash-outline';
    return 'document-text-outline';
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
    return <View style={{ marginBottom: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12, marginBottom: 6 }}>
            {title !== undefined && <Text style={{ color: theme.colors.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.4, flex: 1 }}>{title}</Text>}
            {folders.length > 0 && <>
                <Pressable onPress={() => setExpanded(new Set(folders))} accessibilityRole="button" accessibilityLabel="Expand all folders" hitSlop={8}>
                    <Text style={{ color: theme.colors.textLink, fontSize: 12, paddingHorizontal: 8 }}>Expand all</Text>
                </Pressable>
                <Pressable onPress={() => setExpanded(new Set())} accessibilityRole="button" accessibilityLabel="Collapse all folders" hitSlop={8}>
                    <Text style={{ color: theme.colors.textLink, fontSize: 12 }}>Collapse</Text>
                </Pressable>
            </>}
        </View>
        <View style={{ backgroundColor: theme.colors.surfaceHigh, borderRadius: 12, paddingVertical: 4 }}>
            {rows.length === 0 ? <Text style={{ color: theme.colors.textSecondary, padding: 14 }}>
                {props.node.emptyText === undefined ? t('plugins.nothingToShow') : bindText(resolvePluginText(props.node.emptyText), props.data)}
            </Text> : rows.map(({ item, depth }) => {
                const isFolder = item.kind === 'folder';
                const open = expanded.has(item.path);
                const busy = loading.has(item.path);
                const selected = props.node.selectionField !== undefined && props.fields[props.node.selectionField] === item.path;
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
                    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingLeft: 12 + Math.min(depth, 8) * 20, paddingRight: 12, opacity: pressed ? 0.6 : 1, backgroundColor: selected ? theme.colors.surfaceHighest : 'transparent' })}>
                    {isFolder && (busy ? <ActivityIndicator size="small" color={theme.colors.textSecondary} style={{ width: 14 }} /> : <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={14} color={theme.colors.textSecondary} />)}
                    {!isFolder && <View style={{ width: 14 }} />}
                    <Ionicons name={treeIcon(item, open)} size={18} color={selected ? theme.colors.accent : theme.colors.textSecondary} style={{ marginHorizontal: 7 }} />
                    <Text numberOfLines={1} style={{ color: selected ? theme.colors.accent : theme.colors.text, fontSize: 14, flex: 1 }}>{item.name}</Text>
                </Pressable>;
            })}
        </View>
    </View>;
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
}) {
    const { theme } = useUnistyles();
    const { node, data, fields } = props;
    const bind = (value: PluginText) => bindText(resolvePluginText(value), data);
    switch (node.type) {
        case 'text':
            return <Text style={{ color: toneColor(theme, node.tone), fontSize: 15, lineHeight: 21, marginBottom: 8 }}>{bind(node.text)}</Text>;
        case 'row':
            return <ScreenRow row={node} data={data} onRowAction={props.onRowAction} style={{ paddingVertical: 10 }} />;
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
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>{bind(node.label)}</Text>
                    <Text style={{ color: theme.colors.text, fontSize: 22, fontWeight: '600', marginTop: 2 }}>{bind(node.value)}</Text>
                </View>
            );
        case 'badge':
            return (
                <View style={{ alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, marginBottom: 8, backgroundColor: theme.colors.surfaceHighest }}>
                    <Text style={{ color: toneColor(theme, node.tone), fontSize: 13, fontWeight: '600' }}>{bind(node.label)}</Text>
                </View>
            );
        case 'progress': {
            const max = node.max ?? 100;
            const pct = Math.max(0, Math.min(100, (node.value / max) * 100));
            return (
                <View style={{ marginBottom: 8 }} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max, now: node.value }}>
                    <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.surfaceHighest, overflow: 'hidden' }}>
                        <View style={{ width: `${pct}%`, height: '100%', backgroundColor: theme.colors.success }} />
                    </View>
                </View>
            );
        }
        case 'divider':
            return <View style={{ height: 1, backgroundColor: theme.colors.divider, marginVertical: 8 }} />;
        case 'empty':
            return (
                <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                    {node.title !== undefined && <Text style={{ color: theme.colors.text, fontSize: 16, fontWeight: '600' }}>{bind(node.title)}</Text>}
                    {node.message !== undefined && <Text style={{ color: theme.colors.textSecondary, fontSize: 14, marginTop: 4, textAlign: 'center' }}>{bind(node.message)}</Text>}
                </View>
            );
        case 'section':
            return (
                <View style={{ marginBottom: 8 }}>
                    {node.title !== undefined && <Text style={{ color: theme.colors.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6, marginTop: 12 }}>{bind(node.title)}</Text>}
                    <View style={{ backgroundColor: theme.colors.surfaceHigh, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 6 }}>
                        {node.children.map((child, index) => <ScreenNode key={index} {...props} node={child} />)}
                    </View>
                </View>
            );
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
                <View style={{ marginBottom: 8 }}>
                    {node.title !== undefined && <Text style={{ color: theme.colors.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6, marginTop: 12 }}>{bind(node.title)}</Text>}
                    <View style={{ backgroundColor: theme.colors.surfaceHigh, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 6 }}>
                        {all.length === 0
                            ? <Text style={{ color: theme.colors.textSecondary, fontSize: 14, paddingVertical: 10 }}>{bind(node.emptyText ?? t('plugins.nothingToShow'))}</Text>
                            : all.map(({ row, item }, index) => (
                                <ScreenRow key={index} row={row} data={data} item={item} onRowAction={props.onRowAction}
                                    style={{ paddingVertical: 10, borderTopWidth: index === 0 ? 0 : 1, borderTopColor: theme.colors.divider }} />
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
                                    <Pressable key={optionValue} onPress={() => set(optionValue)} accessibilityRole="button" accessibilityState={{ selected }}
                                        style={{ borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: selected ? theme.colors.accent : theme.colors.surfaceHighest }}>
                                        <Text style={{ color: selected ? '#fff' : theme.colors.text, fontSize: 14 }}>{resolvePluginText(option)}</Text>
                                    </Pressable>
                                );
                            })}
                        </View>
                    </View>
                );
            }
            return (
                <View style={{ paddingVertical: 8 }}>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginBottom: 6 }}>{bind(node.label)}</Text>
                    <TextInput
                        value={typeof value === 'string' ? value : ''}
                        onChangeText={set}
                        placeholder={node.placeholder !== undefined ? bind(node.placeholder) : undefined}
                        placeholderTextColor={theme.colors.textSecondary}
                        maxLength={1024}
                        accessibilityLabel={bind(node.label)}
                        style={{ color: theme.colors.text, fontSize: 15, backgroundColor: theme.colors.surfaceHighest, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 }}
                    />
                </View>
            );
        }
        case 'button': {
            // Danger uses the theme's error surface: a solid red fill with a
            // white label instead of the old red-on-red text-on-text.
            const variantColor = node.variant === 'danger'
                ? theme.colors.box.error.border
                : node.variant === 'primary' ? theme.colors.accent : theme.colors.surfaceHighest;
            const labelColor = node.variant === 'danger' || node.variant === 'primary' ? '#fff' : theme.colors.text;
            return (
                <Pressable
                    onPress={() => props.onButton(node)}
                    disabled={props.running}
                    accessibilityRole="button"
                    accessibilityLabel={bind(node.label)}
                    accessibilityState={{ busy: props.running, disabled: props.running }}
                    style={{ borderRadius: 10, paddingVertical: 11, alignItems: 'center', backgroundColor: variantColor, marginVertical: 6, opacity: props.running ? 0.6 : 1 }}>
                    {props.running ? <ActivityIndicator color={labelColor} /> : <Text style={{ color: labelColor, fontSize: 15, fontWeight: '600' }}>{bind(node.label)}</Text>}
                </Pressable>
            );
        }
    }
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
    const [data, setData] = React.useState<unknown>(undefined);
    const [dataError, setDataError] = React.useState<string>();
    const [fields, setFields] = React.useState<ScreenFieldValues>(() => initialFieldValues(screen));
    const [running, setRunning] = React.useState(false);
    const [status, setStatus] = React.useState<{ ok: boolean; text: string }>();
    const [refreshNonce, setRefreshNonce] = React.useState(0);
    const operationVersion = React.useRef(0);
    const dirtyFields = React.useRef(new Set<string>());
    const writeKeys = sharedPluginWriteKeys;
    const request = React.useCallback((type: 'plugin.call', params: RequestParams<'plugin.call'>): Promise<unknown> => sync.request(type, params, PLUGIN_CALL_CLIENT_TIMEOUT_MS), []);
    const dataContributionId = screen.data?.contributionId;
    React.useEffect(() => {
        operationVersion.current += 1;
        dirtyFields.current.clear();
        setRunning(false);
        return () => { operationVersion.current += 1; };
    }, [props.manifest, props.manifestHash, props.params]);
    React.useEffect(() => subscribePluginDataInvalidation(props.pluginId, () => {
        if (dataContributionId !== undefined) setRefreshNonce((value) => value + 1);
    }), [dataContributionId, props.pluginId]);
    React.useEffect(() => {
        if (dataContributionId === undefined) return;
        let cancelled = false;
        setData(undefined);
        setDataError(undefined);
        void loadScreenData(dataContributionId, props.manifest, props.pluginId, props.manifestHash, request, props.params)
            .then((value) => {
                if (cancelled) return;
                setData(value);
                const defaults = initialFieldValues(screen, value);
                setFields((current) => Object.fromEntries(Object.entries(defaults).map(([id, initial]) =>
                    [id, dirtyFields.current.has(id) ? current[id] ?? initial : initial])));
            })
            .catch((error: unknown) => { if (!cancelled) setDataError(error instanceof Error ? error.message : String(error)); });
        return () => { cancelled = true; };
    }, [dataContributionId, props.manifest, props.pluginId, props.manifestHash, props.params, request, refreshNonce]);

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
                setStatus({ ok: true, text: t('inbox.reason.done') });
                if (shouldReloadAfterAction(props.manifest, button.action, true)) setRefreshNonce((value) => value + 1);
            }).catch((error: unknown) => {
                if (version === operationVersion.current) setStatus({ ok: false, text: error instanceof Error ? error.message : String(error) });
            }).finally(() => setRunning(false));
            return;
        }
        // The retained write key is scoped to this contribution+manifest, so a
        // duplicate press with unchanged input reuses it (host replay-fences).
        const slot = `${props.pluginId}:${props.manifestHash}:${button.action.contributionId}`;
        void runScreenButton({
            button, fields, pluginId: props.pluginId, manifestHash: props.manifestHash,
            manifest: props.manifest, writeKeys,
            ...(props.params === undefined ? {} : { params: props.params }),
            slot, newIdempotencyKey: () => newIdempotencyKey(),
        }, request).then((outcome) => {
            setRunning(false);
            if (version !== operationVersion.current) return;
            setStatus(outcome);
            if (shouldReloadAfterAction(props.manifest, button.action, outcome.ok)) setRefreshNonce((value) => value + 1);
        });
    }, [fields, props.pluginId, props.manifestHash, props.manifest, props.params, request, router, writeKeys]);

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
            { ...(props.params ?? {}), path },
        );
        return asScreenTree(resolvePath(value, node.path));
    }, [props.manifest, props.manifestHash, props.params, props.pluginId, request]);

    const { theme } = useUnistyles();
    return (
        <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
            <View style={{ marginBottom: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.divider, paddingBottom: 10 }}>
                <Text style={{ color: theme.colors.text, fontSize: 13, fontWeight: '600' }}>{props.pluginName}</Text>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 1 }}>{sourceLabel(props.source)}</Text>
            </View>
            {screen.title !== undefined && <Text style={{ color: theme.colors.text, fontSize: 26, fontWeight: '700', marginBottom: 12 }}>{bindText(resolvePluginText(screen.title), data)}</Text>}
            {/* Show why, not just that: a plugin author debugging a screen has
                nothing to go on otherwise. The host already bounds this text. */}
            {dataError !== undefined && <Pressable onPress={() => setRefreshNonce((value) => value + 1)} accessibilityRole="button" accessibilityLabel={`${capUtf8Bytes(sanitizeDisplayText(dataError), 300)}. ${t('plugins.retry')}`} style={{ marginBottom: 8, paddingVertical: 10 }}>
                <Text style={{ color: theme.colors.box.error.text, fontSize: 13 }}>{capUtf8Bytes(sanitizeDisplayText(dataError), 300)}</Text>
                <Text style={{ color: theme.colors.textLink, fontSize: 13, marginTop: 4 }}>{t('plugins.retry')}</Text>
            </Pressable>}
            {screen.children.map((node, index) => <ScreenNode key={index} node={node} data={data} fields={fields} setField={setField} running={running} onButton={onButton} onRowAction={onRowAction} onTreeLoad={onTreeLoad}
                onTreeError={(error) => setStatus({ ok: false, text: error instanceof Error ? error.message : String(error) })} />)}
            {status !== undefined && (
                <Text accessibilityLiveRegion="polite" accessibilityRole="alert"
                    style={{ color: status.ok ? theme.colors.success : theme.colors.box.error.text, fontSize: 13, marginTop: 10 }}>
                    {status.text}
                </Text>
            )}
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
