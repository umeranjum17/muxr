import * as React from 'react';
import { ActivityIndicator, AppState, FlatList, Pressable, Text, View, useWindowDimensions, type ViewToken } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useIsFocused } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { OptionSheet } from '@/components/OptionSheet';
import { hapticsError, hapticsLight } from '@/components/haptics';
import { Modal } from '@/modal';
import { sync } from '@/catalog/sync';
import { Typography } from '@/constants/Typography';
import { PLUGIN_CALL_CLIENT_TIMEOUT_MS } from '@muxr/contract';
import type { PrimitiveProps } from '../../domain/primitiveTypes'
import { asPluginItemList, type PluginItemListAction, type PluginItemListItem, type PluginItemListModel } from '../../domain/itemListModel';
import { dispatchPluginAction, validatePluginAction } from '../../application/pluginActions';
import { pluginSnapshot } from '../../application/pluginStore';
import { clearPluginCache, registerPluginDataCacheInvalidator, subscribePluginDataInvalidation } from '../../application/pluginDataInvalidation';
import { toneColor } from '../../domain/pluginTone';
import { cardStyle, Meter, SectionLabel, ui, withAlpha } from '@/components/ui';
import { resolvePluginText } from '../../domain/pluginText';
import { t } from '@/text';
import { AttachmentGallery, AttachmentThumbnail, type GalleryImage } from '@/components/AttachmentGallery';
import type { AttachmentAction } from '@/utils/attachmentPreview';

const EMPTY_MODEL: PluginItemListModel = { items: [], actions: [] };
const MAX_ACTIVE_THUMBNAILS = 4;

type SheetListEntry =
    | { key: string; kind: 'label'; name: string; spaced: boolean }
    | { key: string; kind: 'images'; images: { image: GalleryImage; galleryIndex: number }[]; spaced: boolean }
    | { key: string; kind: 'item'; item: PluginItemListItem; index: number; rowIndex: number; rowCount: number; spaced: boolean };

function imageAction(item: PluginItemListItem): AttachmentAction | undefined {
    return item.action?.type === 'attachment' && item.action.mimeType?.startsWith('image/') ? item.action : undefined;
}
const cache = new Map<string, PluginItemListModel>();
registerPluginDataCacheInvalidator((pluginIds) => {
    if (pluginIds === undefined) cache.clear();
    else for (const pluginId of pluginIds) clearPluginCache(cache, pluginId);
});

function SheetRow({ item, fallbackIcon, busy, index, onPress }: {
    item: PluginItemListItem;
    fallbackIcon: string;
    busy: boolean;
    index: number;
    onPress?: () => void;
}) {
    const { theme } = useUnistyles();
    const [primary, ...rest] = item.metadata;
    const metadataLabel = item.metadata.map((entry) => `${entry.label === undefined ? '' : `${entry.label} `}${entry.value}`).join(', ');
    const label = [item.group, item.title, item.subtitle, metadataLabel].filter((part) => part !== undefined && part !== '').join(', ');
    // Work that already landed steps back; anything working or in trouble keeps
    // full contrast, so the eye goes to the row that still needs a person.
    const settled = (item.progress?.tone ?? primary?.tone) === 'positive';
    const content = <View style={{ opacity: settled ? 0.75 : 1 }}>
        <View style={styles.itemRow}>
            {busy
                ? <ActivityIndicator size="small" color={theme.colors.textSecondary} style={styles.iconTile} />
                : <View style={[styles.iconTile, { backgroundColor: theme.colors.accentSubtle }]}>
                    <Ionicons name={(item.icon ?? fallbackIcon) as never} size={16} color={theme.colors.textSecondary} />
                </View>}
            <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 15, fontWeight: '500' }}>{item.title}</Text>
                {item.subtitle !== undefined && <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 1 }}>{item.subtitle}</Text>}
            </View>
            {primary !== undefined && <View style={styles.metadata}>
                <Text style={[styles.metadataValue, { color: primary.tone === undefined ? theme.colors.text : toneColor(theme, primary.tone) }]}>
                    {primary.label === undefined ? '' : `${primary.label} `}{primary.value}
                </Text>
                {/* Each entry keeps its own tone: a row reads "+26 −12 · repo"
                    with the counts coloured, not one flat grey run-on. */}
                {rest.length > 0 && <Text numberOfLines={1} style={[styles.metadataSecondary, { color: theme.colors.textSecondary }]}>
                    {rest.flatMap((entry, entryIndex) => [
                        ...(entryIndex === 0 ? [] : [<Text key={`separator-${entryIndex}`}>{' · '}</Text>]),
                        <Text key={entryIndex} {...(entry.tone === undefined ? {} : { style: { color: toneColor(theme, entry.tone) } })}>
                            {`${entry.label === undefined ? '' : `${entry.label} `}${entry.value}`}
                        </Text>,
                    ])}
                </Text>}
            </View>}
        </View>
        {item.progress !== undefined && <Meter ratio={item.progress.value} emphasis={1 - index * 0.14} delay={index * 50} style={styles.rowMeter} />}
    </View>;
    if (onPress === undefined) return <View accessible accessibilityLabel={label}>{content}</View>;
    return (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ busy }}
            style={({ pressed }) => pressed && { backgroundColor: theme.colors.surfaceHighest }}>{content}</Pressable>
    );
}

function SheetActions({ actions, busyId, onAction }: {
    actions: PluginItemListAction[];
    busyId: string | null;
    onAction: (action: PluginItemListAction['action'], busyKey: string) => Promise<void>;
}) {
    const { theme } = useUnistyles();
    return <View style={styles.sheetActions}>{actions.map((action) => {
        const busyKey = `action:${action.id}`;
        return <Pressable key={action.id} onPress={() => void onAction(action.action, busyKey)} accessibilityRole="button" accessibilityLabel={action.label}
            accessibilityState={{ busy: busyId === busyKey }}
            style={({ pressed }) => [styles.sheetAction, { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider }, pressed && { backgroundColor: theme.colors.surfaceHighest }]}>
            {busyId === busyKey
                ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                : action.icon !== undefined && <Ionicons name={action.icon as never} size={15} color={theme.colors.textSecondary} />}
            <Text style={{ color: theme.colors.text, fontSize: 13 }}>{action.label}</Text>
        </Pressable>;
    })}</View>;
}

/** Lazy action list: the plugin declares every tap; there are no feature fallbacks. */
export function ItemList({ context, pluginId, manifestHash, contribution, presentation = 'pill' }: PrimitiveProps & { presentation?: 'pill' | 'action-row' }) {
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    const router = useRouter();
    const isFocused = useIsFocused();
    const [appActive, setAppActive] = React.useState(AppState.currentState === 'active');
    const sessionId = 'sessionId' in context ? context.sessionId : undefined;
    const source = contribution.source!;
    const entry = pluginSnapshot().find((candidate) => candidate.summary.pluginId === pluginId && candidate.summary.manifestHash === manifestHash);
    const manifest = entry?.manifest;
    const key = `${pluginId}:${manifestHash}:${source.contributionId}:${sessionId ?? ''}`;
    const [model, setModel] = React.useState<PluginItemListModel>(() => cache.get(key) ?? EMPTY_MODEL);
    const items = model.items;
    const [failed, setFailed] = React.useState(false);
    const [open, setOpen] = React.useState(false);
    const [busyId, setBusyId] = React.useState<string | null>(null);
    const [galleryIndex, setGalleryIndex] = React.useState<number>();
    const loading = React.useRef(false);
    const requestVersion = React.useRef(0);
    const reloadQueued = React.useRef(false);
    const latestLoad = React.useRef<(force?: boolean) => void>(() => {});

    const load = React.useCallback((force = false) => {
        if (manifest === undefined) return;
        if (loading.current) { reloadQueued.current = true; return; }
        if (!force && cache.has(key)) {
            setModel(cache.get(key) ?? EMPTY_MODEL);
            return;
        }
        loading.current = true;
        const version = ++requestVersion.current;
        void sync.request('plugin.call', {
            pluginId,
            manifestHash,
            contributionId: source.contributionId,
            input: sessionId === undefined ? {} : { sessionId },
        }, PLUGIN_CALL_CLIENT_TIMEOUT_MS).then((result) => {
            const context = { pluginId, manifestHash, manifest, ...(sessionId === undefined ? {} : { sessionId }) };
            const next = asPluginItemList(result, (action) => validatePluginAction(action, context));
            if (version === requestVersion.current) {
                cache.set(key, next);
                setModel(next);
                setFailed(false);
            }
        }).catch(() => {
            if (version === requestVersion.current) setFailed(true);
        }).finally(() => {
            if (version !== requestVersion.current) return;
            loading.current = false;
            if (reloadQueued.current) {
                reloadQueued.current = false;
                setTimeout(() => { if (version === requestVersion.current) latestLoad.current(true); }, 0);
            }
        });
    }, [key, manifest, manifestHash, pluginId, sessionId, source.contributionId]);

    latestLoad.current = load;
    React.useEffect(() => {
        requestVersion.current += 1;
        setModel(cache.get(key) ?? EMPTY_MODEL);
        setFailed(false);
        load();
        return () => { requestVersion.current += 1; loading.current = false; reloadQueued.current = false; };
    }, [key, load]);

    React.useEffect(() => subscribePluginDataInvalidation(pluginId, () => {
        clearPluginCache(cache, pluginId);
        load(true);
    }), [load, pluginId]);

    React.useEffect(() => {
        const subscription = AppState.addEventListener('change', (state) => setAppActive(state === 'active'));
        return () => subscription.remove();
    }, []);

    React.useEffect(() => {
        if (model.items.length === 0 && model.actions.length === 0) setOpen(false);
    }, [model.actions.length, model.items.length]);

    React.useEffect(() => {
        const interval = contribution.refreshIntervalMs;
        if (interval === undefined || !isFocused || !appActive) return;
        void load(true);
        const timer = setInterval(() => load(true), interval);
        return () => clearInterval(timer);
    }, [appActive, contribution.refreshIntervalMs, isFocused, load]);

    const onAction = React.useCallback(async (action: PluginItemListItem['action'] | PluginItemListAction['action'], busyKey: string) => {
        if (manifest === undefined || action === undefined) return;
        setBusyId(busyKey);
        try {
            await dispatchPluginAction(action, {
                router, pluginId, manifestHash, manifest,
                ...(sessionId === undefined ? {} : { sessionId }),
            });
            // One dispatch point, so every plugin tap answers the same way.
            hapticsLight();
            setOpen(false);
        } catch (error) {
            hapticsError();
            Modal.alert(t('plugins.openFailed'), error instanceof Error ? error.message : String(error));
        } finally {
            setBusyId(null);
        }
    }, [manifest, manifestHash, pluginId, router, sessionId]);

    const title = contribution.title === undefined ? t('plugins.items') : resolvePluginText(contribution.title);
    const icon = contribution.icon ?? 'document-outline';
    const accessibilityLabel = contribution.accessibilityLabel === undefined ? title : resolvePluginText(contribution.accessibilityLabel);
    // Order-preserving grouping; ungrouped items render in one silent section.
    const groups = React.useMemo(() => {
        const found: { name?: string; items: { item: PluginItemListItem; index: number }[] }[] = [];
        const byName = new Map<string, { name?: string; items: { item: PluginItemListItem; index: number }[] }>();
        items.forEach((item, index) => {
            const key = item.group ?? '';
            let group = byName.get(key);
            if (group === undefined) {
                group = { ...(item.group === undefined ? {} : { name: item.group }), items: [] };
                byName.set(key, group);
                found.push(group);
            }
            group.items.push({ item, index });
        });
        return found;
    }, [items]);
    const galleryImages = React.useMemo<GalleryImage[]>(() => items.flatMap((item) => {
        const action = imageAction(item);
        return action === undefined ? [] : [{ id: item.id, title: item.title, subtitle: item.subtitle, action }];
    }), [items]);
    const galleryById = React.useMemo(() => new Map(galleryImages.map((image, index) => [image.id, index])), [galleryImages]);
    const galleryWidth = Math.min(220, Math.max(132, (width - 40) / 2));
    const sheetRows = React.useMemo<SheetListEntry[]>(() => groups.flatMap((group, groupIndex) => {
        const rows: SheetListEntry[] = [];
        const spaced = groupIndex > 0 || model.actions.length > 0;
        if (group.name !== undefined) rows.push({ key: `label:${group.name}`, kind: 'label', name: group.name, spaced });
        const images = group.items.flatMap(({ item }) => {
            const galleryIndex = galleryById.get(item.id);
            return galleryIndex === undefined ? [] : [{ image: galleryImages[galleryIndex]!, galleryIndex }];
        });
        for (let index = 0; index < images.length; index += 2) {
            rows.push({ key: `images:${groupIndex}:${index}`, kind: 'images', images: images.slice(index, index + 2), spaced: rows.length === 0 && spaced });
        }
        const plain = group.items.filter(({ item }) => imageAction(item) === undefined);
        plain.forEach(({ item, index }, rowIndex) => rows.push({
            key: `item:${item.id}`, kind: 'item', item, index, rowIndex, rowCount: plain.length,
            spaced: rows.length === 0 && spaced,
        }));
        return rows;
    }), [galleryById, galleryImages, groups, model.actions.length]);
    const sheetBodyHeight = React.useMemo(() => 12 + (model.actions.length > 0 ? 52 : 0) + sheetRows.reduce((height, row) => height
        + (row.spaced ? 14 : 0)
        + (row.kind === 'label' ? 24 : row.kind === 'images' ? galleryWidth / 1.25 + 8 : 53 + (row.rowIndex === row.rowCount - 1 ? 8 : 0)), 0), [galleryWidth, model.actions.length, sheetRows]);
    const [visibleThumbnailIds, setVisibleThumbnailIds] = React.useState<string[]>([]);
    const [settledThumbnailIds, setSettledThumbnailIds] = React.useState<Set<string>>(new Set());
    const thumbnailViewability = React.useRef({ itemVisiblePercentThreshold: 15 }).current;
    const onThumbnailViewable = React.useCallback(({ viewableItems }: { viewableItems: ViewToken<SheetListEntry>[] }) => {
        const next = viewableItems.flatMap(({ item }) => item?.kind === 'images' ? item.images.map(({ image }) => image.id) : []);
        setVisibleThumbnailIds((current) => current.length === next.length && current.every((id, index) => id === next[index]) ? current : next);
    }, []);
    const visibleThumbnailSet = React.useMemo(() => new Set(visibleThumbnailIds), [visibleThumbnailIds]);
    const loadingThumbnailIds = React.useMemo(() => new Set(visibleThumbnailIds.filter((id) => !settledThumbnailIds.has(id)).slice(0, MAX_ACTIVE_THUMBNAILS)), [settledThumbnailIds, visibleThumbnailIds]);
    const thumbnailSettled = React.useCallback((id: string) => setSettledThumbnailIds((current) => {
        if (current.has(id)) return current;
        const next = new Set(current);
        next.add(id);
        return next;
    }), []);
    React.useEffect(() => {
        if (!open) { setVisibleThumbnailIds([]); setSettledThumbnailIds(new Set()); }
    }, [open]);
    const badgeTone = model.badge?.tone;
    const badgeColor = failed ? theme.colors.textDestructive : badgeTone === undefined ? theme.colors.textSecondary : toneColor(theme, badgeTone);
    if (items.length === 0 && model.actions.length === 0) {
        if (!failed && (presentation === 'pill' || presentation === 'action-row')) return null;
        return <Pressable onPress={failed ? () => load(true) : undefined} disabled={!failed} accessibilityRole="button" accessibilityLabel={failed ? `${accessibilityLabel} ${t('plugins.unavailableSuffix')}. ${t('plugins.retry')}` : `${accessibilityLabel}, no items`} hitSlop={11}
            style={({ pressed }) => [presentation === 'action-row' ? styles.actionRow : styles.pill, { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider, opacity: failed || presentation === 'pill' ? 1 : 0.55 }, pressed && { backgroundColor: theme.colors.surfacePressed }]}>
            <Ionicons name={(failed ? 'warning-outline' : icon) as never} size={presentation === 'action-row' ? 18 : 11} color={failed ? theme.colors.textDestructive : theme.colors.textSecondary} />
            {presentation === 'action-row' && <Text style={[styles.actionLabel, { color: theme.colors.text }]}>{title}</Text>}
            <Text style={[styles.count, { color: failed ? theme.colors.textDestructive : theme.colors.textSecondary }]}>{failed ? '!' : '0'}</Text>
        </Pressable>;
    }
    const count = model.badge?.value ?? items.length;
    return <>
        <Pressable onPress={() => { setOpen(true); load(true); }} accessibilityRole="button" accessibilityLabel={`${accessibilityLabel}${failed ? `, ${t('plugins.showingStale')}. ${t('plugins.retry')}` : ''}`} hitSlop={11}
            style={({ pressed }) => [presentation === 'action-row' ? styles.actionRow : styles.pill, { backgroundColor: theme.colors.surfaceHigh, borderColor: failed ? theme.colors.textDestructive : theme.colors.divider }, pressed && { backgroundColor: theme.colors.surfacePressed }]}>
            <Ionicons name={(failed ? 'warning-outline' : icon) as never} size={presentation === 'action-row' ? 18 : 11} color={badgeColor} />
            {presentation === 'action-row' && <Text style={[styles.actionLabel, { color: theme.colors.text }]}>{title}</Text>}
            <Text style={[styles.count, { color: badgeColor }]}>{count}</Text>
            {presentation === 'action-row' && <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />}
        </Pressable>
        <OptionSheet visible={open} title={title} options={[]} onSelect={() => {}} onClose={() => setOpen(false)} virtualizedBody={galleryImages.length > 0} virtualizedBodyHeight={sheetBodyHeight} body={
            galleryImages.length > 0
                ? <FlatList
                    data={sheetRows}
                    keyExtractor={(row) => row.key}
                    contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12 }}
                    initialNumToRender={4}
                    maxToRenderPerBatch={4}
                    windowSize={3}
                    viewabilityConfig={thumbnailViewability}
                    onViewableItemsChanged={onThumbnailViewable}
                    ListHeaderComponent={model.actions.length > 0 ? <SheetActions actions={model.actions} busyId={busyId} onAction={onAction} /> : null}
                    renderItem={({ item: row }) => {
                        if (row.kind === 'label') return <SectionLabel style={[styles.groupLabel, row.spaced && styles.spacedRow]}>{row.name}</SectionLabel>;
                        if (row.kind === 'images') return <View style={[styles.imageGrid, row.spaced && styles.spacedRow]}>{row.images.map(({ image, galleryIndex }) => <View key={image.id} style={{ width: galleryWidth }}>
                            <AttachmentThumbnail sessionId={sessionId!} image={image} enabled={visibleThumbnailSet.has(image.id) && (settledThumbnailIds.has(image.id) || loadingThumbnailIds.has(image.id))} onSettled={thumbnailSettled} onPress={() => setGalleryIndex(galleryIndex)} />
                        </View>)}</View>;
                        const first = row.rowIndex === 0;
                        const last = row.rowIndex === row.rowCount - 1;
                        return <View style={[styles.virtualRow, { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider }, first && styles.virtualRowFirst, last && styles.virtualRowLast, row.spaced && styles.spacedRow]}>
                            {!first && <View style={[styles.rowDivider, { backgroundColor: theme.colors.divider }]} />}
                            <SheetRow item={row.item} fallbackIcon={icon} busy={busyId === `item:${row.item.id}`} index={row.index}
                                {...(row.item.action === undefined ? {} : { onPress: () => void onAction(row.item.action, `item:${row.item.id}`) })} />
                        </View>;
                    }}
                />
                : <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                    {model.actions.length > 0 && <SheetActions actions={model.actions} busyId={busyId} onAction={onAction} />}
                    {groups.map((group, groupIndex) => <View key={group.name ?? `ungrouped-${groupIndex}`} style={{ marginTop: groupIndex === 0 && model.actions.length === 0 ? 0 : 14 }}>
                        {group.name !== undefined && <SectionLabel style={styles.groupLabel}>{group.name}</SectionLabel>}
                        <View style={[cardStyle(theme), { overflow: 'hidden' }]}>
                            {group.items.map(({ item, index }, rowIndex) => <React.Fragment key={item.id}>
                                {rowIndex > 0 && <View style={[styles.rowDivider, { backgroundColor: theme.colors.divider }]} />}
                                <SheetRow item={item} fallbackIcon={icon} busy={busyId === `item:${item.id}`} index={index}
                                    {...(item.action === undefined ? {} : { onPress: () => void onAction(item.action, `item:${item.id}`) })} />
                            </React.Fragment>)}
                        </View>
                    </View>)}
                </View>
        } />
        {galleryIndex !== undefined && <AttachmentGallery sessionId={sessionId!} images={galleryImages} initialIndex={galleryIndex} onClose={() => setGalleryIndex(undefined)} />}
    </>;
}

const styles = StyleSheet.create({
    pill: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 26, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8 },
    actionRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 8 },
    actionLabel: { flex: 1, fontSize: 15 },
    count: { fontSize: 11, ...Typography.mono('semiBold') },
    sheetActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingBottom: 4 },
    imageGrid: { flexDirection: 'row', gap: 8, marginBottom: 8 },
    spacedRow: { marginTop: 14 },
    virtualRow: { borderLeftWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
    virtualRowFirst: { borderTopWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: ui.radius.card, borderTopRightRadius: ui.radius.card },
    virtualRowLast: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomLeftRadius: ui.radius.card, borderBottomRightRadius: ui.radius.card, marginBottom: 8 },
    sheetAction: { minHeight: 44, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6 },
    groupLabel: { marginBottom: 8, marginLeft: 4 },
    rowDivider: { height: StyleSheet.hairlineWidth, marginLeft: 54 },
    itemRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 11 },
    iconTile: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
    metadata: { alignItems: 'flex-end', gap: 2, marginLeft: 8 },
    metadataValue: { fontSize: 13, ...Typography.mono('semiBold') },
    metadataSecondary: { fontSize: 11, ...Typography.mono('regular') },
    rowMeter: { marginLeft: 54, marginRight: 14, marginTop: -2, marginBottom: 11 },
});
