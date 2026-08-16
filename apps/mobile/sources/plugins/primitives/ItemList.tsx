import * as React from 'react';
import { ActivityIndicator, AppState, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useIsFocused } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { OptionSheet } from '@/components/OptionSheet';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { Typography } from '@/constants/Typography';
import { PLUGIN_CALL_CLIENT_TIMEOUT_MS } from '@muxr/contract';
import type { Theme } from '@/theme';
import type { PrimitiveProps } from '../primitiveRegistry';
import { asPluginItemList, type PluginItemListAction, type PluginItemListItem, type PluginItemListModel, type PluginItemMetadata } from '../itemListModel';
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

function metadataColor(metadata: PluginItemMetadata, theme: Theme): string {
    switch (metadata.tone) {
        case 'positive': return theme.colors.status.done;
        case 'warning': return theme.colors.status.working;
        case 'danger': return theme.colors.status.error;
        case 'primary': return theme.colors.accent;
        default: return theme.colors.textSecondary;
    }
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

    const onAction = React.useCallback(async (entry: PluginItemListItem | PluginItemListAction, busyKey: string) => {
        if (manifest === undefined) return;
        setBusyId(busyKey);
        try {
            await dispatchPluginAction(entry.action, {
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
            <Ionicons name={(failed ? 'warning-outline' : icon) as never} size={11} color={failed ? theme.colors.textDestructive : theme.colors.textSecondary} />
            <Text style={[styles.count, { color: theme.colors.textSecondary }]}>{items.length}</Text>
        </Pressable>
        <OptionSheet visible={open} title={title} options={[]} onSelect={() => {}} onClose={() => setOpen(false)} body={
            <View style={{ paddingHorizontal: 16, paddingBottom: 12, gap: 8 }}>
                {model.actions.length > 0 && <View style={styles.sheetActions}>
                    {model.actions.map((action) => {
                        const busyKey = `action:${action.id}`;
                        return <Pressable key={action.id} onPress={() => void onAction(action, busyKey)} accessibilityRole="button" accessibilityLabel={action.label}
                            accessibilityState={{ busy: busyId === busyKey }}
                            style={({ pressed }) => [styles.sheetAction, { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider }, pressed && { opacity: 0.6 }]}>
                            {busyId === busyKey
                                ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                : action.icon !== undefined && <Ionicons name={action.icon as never} size={15} color={theme.colors.textSecondary} />}
                            <Text style={{ color: theme.colors.text, fontSize: 13 }}>{action.label}</Text>
                        </Pressable>;
                    })}
                </View>}
                {items.map((item) => {
                    const busyKey = `item:${item.id}`;
                    const metadataLabel = item.metadata.map((entry) => `${entry.label === undefined ? '' : `${entry.label} `}${entry.value}`).join(', ');
                    return <Pressable key={item.id} onPress={() => void onAction(item, busyKey)} accessibilityRole="button" accessibilityLabel={`${item.title}${metadataLabel === '' ? '' : `, ${metadataLabel}`}`}
                        accessibilityState={{ busy: busyId === busyKey }} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 }}>
                        {busyId === busyKey
                            ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                            : <Ionicons name={(item.icon ?? icon) as never} size={18} color={theme.colors.textSecondary} />}
                        <View style={{ flex: 1 }}>
                            <Text style={{ color: theme.colors.text, fontSize: 14 }}>{item.title}</Text>
                            {item.subtitle !== undefined && <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>{item.subtitle}</Text>}
                        </View>
                        {item.metadata.length > 0 && <View style={styles.metadata}>
                            {item.metadata.map((entry, index) => <Text key={`${entry.label ?? ''}:${index}`} style={[styles.metadataText, { color: metadataColor(entry, theme) }]}>
                                {entry.label === undefined ? '' : `${entry.label} `}{entry.value}
                            </Text>)}
                        </View>}
                    </Pressable>;
                })}
            </View>
        } />
    </>;
}

const styles = StyleSheet.create({
    pill: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 26, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8 },
    count: { fontSize: 11, ...Typography.mono('semiBold') },
    sheetActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingBottom: 4 },
    sheetAction: { minHeight: 44, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6 },
    metadata: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    metadataText: { fontSize: 12, ...Typography.mono('semiBold') },
});
