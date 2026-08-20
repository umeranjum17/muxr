import * as React from 'react';
import { ActivityIndicator, AppState, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useIsFocused } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { OptionSheet } from '@/components/OptionSheet';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { Typography } from '@/constants/Typography';
import { PLUGIN_CALL_CLIENT_TIMEOUT_MS } from '@muxr/contract';
import type { Theme } from '@/theme';
import type { PluginScreenTone } from '@muxr/contract';
import type { PrimitiveProps } from '../primitiveRegistry';
import { asPluginItemList, type PluginItemListAction, type PluginItemListItem, type PluginItemListModel } from '../itemListModel';
import { dispatchPluginAction, validatePluginAction } from '../pluginActions';
import { pluginSnapshot } from '../pluginStore';
import { clearPluginCache, registerPluginDataCacheInvalidator, subscribePluginDataInvalidation } from '../pluginDataInvalidation';
import { resolvePluginText } from '../pluginText';
import { t } from '@/text';

const EMPTY_MODEL: PluginItemListModel = { items: [], actions: [] };
const cache = new Map<string, PluginItemListModel>();
registerPluginDataCacheInvalidator((pluginIds) => {
    if (pluginIds === undefined) cache.clear();
    else for (const pluginId of pluginIds) clearPluginCache(cache, pluginId);
});

function toneColor(theme: Theme, tone: PluginScreenTone | undefined): string {
    switch (tone) {
        case 'positive': return theme.colors.status.done;
        case 'warning': return theme.colors.status.working;
        case 'danger': return theme.colors.status.error;
        case 'primary': return theme.colors.accent;
        default: return theme.colors.textSecondary;
    }
}

function withAlpha(color: string, alpha: number): string {
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
    if (hex === undefined) return color;
    const full = hex.length === 3 ? hex.split('').map((part) => part + part).join('') : hex;
    const value = Number.parseInt(full, 16);
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha.toFixed(3)})`;
}

/** Thin fill bar that sweeps in once on mount; decorative, never blocks taps. */
function RowProgress({ value, color, delay }: { value: number; color: string; delay: number }) {
    const { theme } = useUnistyles();
    const reduceMotion = useReducedMotion();
    const width = useSharedValue(reduceMotion ? value : 0);
    React.useEffect(() => {
        width.value = reduceMotion ? value : withDelay(delay, withTiming(value, { duration: 350, easing: Easing.bezier(0.23, 1, 0.32, 1) }));
    }, [delay, reduceMotion, value, width]);
    const animated = useAnimatedStyle(() => ({ width: `${width.value * 100}%` }));
    return (
        <View style={[styles.progressTrack, { backgroundColor: theme.colors.surfaceHighest }]}>
            <Animated.View style={[styles.progressFill, { backgroundColor: color }, animated]} />
        </View>
    );
}

function SheetRow({ item, fallbackIcon, busy, index, onPress }: {
    item: PluginItemListItem;
    fallbackIcon: string;
    busy: boolean;
    index: number;
    onPress?: () => void;
}) {
    const { theme } = useUnistyles();
    const [primary, ...rest] = item.metadata;
    const secondary = rest.map((entry) => `${entry.label === undefined ? '' : `${entry.label} `}${entry.value}`.trim()).join(' · ');
    const metadataLabel = item.metadata.map((entry) => `${entry.label === undefined ? '' : `${entry.label} `}${entry.value}`).join(', ');
    const label = [item.group, item.title, item.subtitle, metadataLabel].filter((part) => part !== undefined && part !== '').join(', ');
    // Untoned bars step back down the list: a column of identical full-strength
    // accent reads as decoration rather than ranking.
    const progressColor = item.progress?.tone === undefined
        ? withAlpha(theme.colors.accent, Math.max(0.4, 1 - index * 0.14))
        : toneColor(theme, item.progress.tone);
    const content = <>
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
                {secondary !== '' && <Text numberOfLines={1} style={[styles.metadataSecondary, { color: theme.colors.textSecondary }]}>{secondary}</Text>}
            </View>}
        </View>
        {item.progress !== undefined && <RowProgress value={item.progress.value} color={progressColor} delay={index * 50} />}
    </>;
    if (onPress === undefined) return <View accessible accessibilityLabel={label}>{content}</View>;
    return (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ busy }}
            style={({ pressed }) => pressed && { opacity: 0.6 }}>{content}</Pressable>
    );
}

/** Lazy action list: the plugin declares every tap; there are no feature fallbacks. */
export function ItemList({ context, pluginId, manifestHash, contribution }: PrimitiveProps) {
    const { theme } = useUnistyles();
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
            setOpen(false);
        } catch (error) {
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
    const badgeTone = model.badge?.tone;
    const badgeColor = failed ? theme.colors.textDestructive : badgeTone === undefined ? theme.colors.textSecondary : toneColor(theme, badgeTone);
    if (items.length === 0 && model.actions.length === 0) {
        if (!failed) return null;
        return <Pressable onPress={() => load(true)} accessibilityRole="button" accessibilityLabel={`${accessibilityLabel} ${t('plugins.unavailableSuffix')}. ${t('plugins.retry')}`} hitSlop={11}
            style={({ pressed }) => [styles.pill, { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider }, pressed && { opacity: 0.6 }]}>
            <Ionicons name="warning-outline" size={11} color={theme.colors.textDestructive} />
            <Text style={[styles.count, { color: theme.colors.textDestructive }]}>!</Text>
        </Pressable>;
    }
    return <>
        <Pressable onPress={() => { setOpen(true); load(true); }} accessibilityRole="button" accessibilityLabel={`${accessibilityLabel}${failed ? `, ${t('plugins.showingStale')}. ${t('plugins.retry')}` : ''}`} hitSlop={11}
            style={({ pressed }) => [styles.pill, { backgroundColor: theme.colors.surfaceHigh, borderColor: failed ? theme.colors.textDestructive : theme.colors.divider }, pressed && { opacity: 0.6 }]}>
            <Ionicons name={(failed ? 'warning-outline' : icon) as never} size={11} color={badgeColor} />
            <Text style={[styles.count, { color: badgeColor }]}>{model.badge?.value ?? items.length}</Text>
        </Pressable>
        <OptionSheet visible={open} title={title} options={[]} onSelect={() => {}} onClose={() => setOpen(false)} body={
            <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                {model.actions.length > 0 && <View style={styles.sheetActions}>
                    {model.actions.map((action) => {
                        const busyKey = `action:${action.id}`;
                        return <Pressable key={action.id} onPress={() => void onAction(action.action, busyKey)} accessibilityRole="button" accessibilityLabel={action.label}
                            accessibilityState={{ busy: busyId === busyKey }}
                            style={({ pressed }) => [styles.sheetAction, { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider }, pressed && { opacity: 0.6 }]}>
                            {busyId === busyKey
                                ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                : action.icon !== undefined && <Ionicons name={action.icon as never} size={15} color={theme.colors.textSecondary} />}
                            <Text style={{ color: theme.colors.text, fontSize: 13 }}>{action.label}</Text>
                        </Pressable>;
                    })}
                </View>}
                {groups.map((group, groupIndex) => (
                    <View key={group.name ?? `ungrouped-${groupIndex}`} style={{ marginTop: groupIndex === 0 && model.actions.length === 0 ? 0 : 14 }}>
                        {group.name !== undefined && <Text style={[styles.groupLabel, { color: theme.colors.textSecondary }]}>{group.name}</Text>}
                        <View style={[styles.groupCard, { backgroundColor: theme.colors.surfaceHigh }]}>
                            {group.items.map(({ item, index }, rowIndex) => (
                                <React.Fragment key={item.id}>
                                    {rowIndex > 0 && <View style={[styles.rowDivider, { backgroundColor: theme.colors.divider }]} />}
                                    <SheetRow item={item} fallbackIcon={icon} busy={busyId === `item:${item.id}`} index={index}
                                        {...(item.action === undefined ? {} : { onPress: () => void onAction(item.action, `item:${item.id}`) })} />
                                </React.Fragment>
                            ))}
                        </View>
                    </View>
                ))}
            </View>
        } />
    </>;
}

const styles = StyleSheet.create({
    pill: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 26, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8 },
    count: { fontSize: 11, ...Typography.mono('semiBold') },
    sheetActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingBottom: 4 },
    sheetAction: { minHeight: 44, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6 },
    // One label scale across plugin surfaces: 12/600/0.6 is the section voice
    // on declarative screens, and a sheet that whispers at 11/0.8 reads as a
    // different app.
    groupLabel: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8, marginLeft: 4 },
    groupCard: { borderRadius: 16, overflow: 'hidden' },
    rowDivider: { height: StyleSheet.hairlineWidth, marginLeft: 54 },
    itemRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 11 },
    iconTile: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
    metadata: { alignItems: 'flex-end', gap: 2, marginLeft: 8 },
    metadataValue: { fontSize: 13, ...Typography.mono('semiBold') },
    metadataSecondary: { fontSize: 11 },
    progressTrack: { height: 4, borderRadius: 2, marginLeft: 54, marginRight: 14, marginTop: -2, marginBottom: 11, overflow: 'hidden' },
    progressFill: { height: '100%', borderRadius: 2 },
});
