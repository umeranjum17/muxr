import * as React from 'react';
import { ActivityIndicator, AppState, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { ItemGroup } from '@/components/ItemGroup';
import { StatusDot } from '@/components/StatusDot';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { PLUGIN_CALL_CLIENT_TIMEOUT_MS } from '@muxr/contract';
import type { PrimitiveProps } from '../../domain/primitiveTypes'
import { asPluginCollection, type PluginCollectionGroup, type PluginCollectionItem } from '../../domain/collectionModel';
import { dispatchPluginAction, validatePluginAction } from '../../application/pluginActions';
import { pluginSnapshot } from '../../application/pluginStore';
import { clearPluginCache, registerPluginDataCacheInvalidator, subscribePluginDataInvalidation } from '../../application/pluginDataInvalidation';
import { toneColor } from '../../domain/pluginTone';
import { resolvePluginText } from '../../domain/pluginText';
import { t } from '@/text';

const REFRESH_MS = 15_000;
const cache = new Map<string, PluginCollectionGroup[]>();

function collectionEmptyTitle(failed: boolean, contribution: PrimitiveProps['contribution']): string {
    if (failed) return t('plugins.couldNotLoad');
    if (contribution.emptyTitle === undefined) return t('plugins.nothingHere');
    return resolvePluginText(contribution.emptyTitle);
}

function collectionEmptyMessage(failed: boolean, contribution: PrimitiveProps['contribution']): string {
    if (failed) return t('plugins.dataUnavailable');
    if (contribution.emptyMessage === undefined) return t('plugins.newItems');
    return resolvePluginText(contribution.emptyMessage);
}

function collectionItemLabel(item: PluginCollectionItem): string {
    let label = item.title;
    if (item.subtitle !== undefined) label += `: ${item.subtitle}`;
    if (item.status === 'positive') label += `, ${t('common.success')}`;
    else if (item.status === 'danger') label += `, ${t('common.error')}`;
    return label;
}
registerPluginDataCacheInvalidator((pluginIds) => {
    if (pluginIds === undefined) cache.clear();
    else for (const pluginId of pluginIds) clearPluginCache(cache, pluginId);
});

function relativeTime(value: string): string {
    const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
    if (seconds < 60) return t('time.justNow');
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return t('time.minutesAgo', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('time.hoursAgo', { count: hours });
    return t('time.daysAgo', { count: Math.floor(hours / 24) });
}

function ItemVisual({ item }: { item: PluginCollectionItem }) {
    const { theme } = useUnistyles();
    if (item.icon !== undefined) return <Ionicons name={item.icon as never} size={22} color={theme.colors.textSecondary} />;
    const letter = (item.glyph ?? item.title).trim().charAt(0).toUpperCase() || '·';
    return <View style={{ width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceHigh, borderWidth: 1, borderColor: theme.colors.divider }}>
        <Text style={{ color: theme.colors.textSecondary, fontSize: 15, fontWeight: '600' }}>{letter}</Text>
    </View>;
}

export function CollectionView({ context, pluginId, manifestHash, contribution }: PrimitiveProps) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const isFocused = useIsFocused();
    const safeArea = useSafeAreaInsets();
    const [appActive, setAppActive] = React.useState(AppState.currentState === 'active');
    const source = contribution.source!;
    const entry = pluginSnapshot().find((candidate) => candidate.summary.pluginId === pluginId && candidate.summary.manifestHash === manifestHash);
    const manifest = entry?.manifest;
    const key = `${pluginId}:${manifestHash}:${source.contributionId}`;
    const [groups, setGroups] = React.useState<PluginCollectionGroup[]>(() => cache.get(key) ?? []);
    const [loading, setLoading] = React.useState(() => !cache.has(key));
    const [failed, setFailed] = React.useState(false);
    const loadingRef = React.useRef(false);
    const requestVersion = React.useRef(0);
    const reloadQueued = React.useRef(false);
    const latestLoad = React.useRef<(showSpinner?: boolean) => Promise<void>>(async () => {});

    const validate = React.useCallback((value: unknown) => {
        if (manifest === undefined) throw new Error('Plugin manifest unavailable');
        return validatePluginAction(value, { pluginId, manifestHash, manifest });
    }, [manifest, manifestHash, pluginId]);

    const load = React.useCallback(async (showSpinner = false) => {
        if (manifest === undefined) return;
        if (loadingRef.current) { reloadQueued.current = true; return; }
        loadingRef.current = true;
        const version = ++requestVersion.current;
        if (showSpinner) setLoading(true);
        try {
            const result = await sync.request('plugin.call', { pluginId, manifestHash, contributionId: source.contributionId }, PLUGIN_CALL_CLIENT_TIMEOUT_MS);
            const parsed = asPluginCollection(result, validate);
            cache.set(key, parsed.groups);
            if (version === requestVersion.current) {
                setGroups(parsed.groups);
                setFailed(false);
            }
        } catch {
            if (version === requestVersion.current) setFailed(true);
        } finally {
            loadingRef.current = false;
            if (version === requestVersion.current) setLoading(false);
            if (reloadQueued.current) {
                reloadQueued.current = false;
                setTimeout(() => void latestLoad.current(true), 0);
            }
        }
    }, [key, manifest, manifestHash, pluginId, source.contributionId, validate]);

    latestLoad.current = load;
    React.useEffect(() => {
        requestVersion.current += 1;
        setGroups(cache.get(key) ?? []);
        setFailed(false);
        void load(!cache.has(key));
        return () => { requestVersion.current += 1; };
    }, [key, load]);
    React.useEffect(() => {
        const subscription = AppState.addEventListener('change', (state) => setAppActive(state === 'active'));
        return () => subscription.remove();
    }, []);
    React.useEffect(() => {
        if (!isFocused || !appActive) return;
        const timer = setInterval(() => void load(), REFRESH_MS);
        return () => clearInterval(timer);
    }, [appActive, isFocused, load]);
    React.useEffect(() => subscribePluginDataInvalidation(pluginId, () => {
        clearPluginCache(cache, pluginId);
        void load(true);
    }), [load, pluginId]);

    const openItem = React.useCallback(async (item: PluginCollectionItem) => {
        if (manifest === undefined) return;
        try {
            await dispatchPluginAction(item.action, { router, pluginId, manifestHash, manifest });
        } catch (error) {
            Modal.alert(t('plugins.openFailed'), error instanceof Error ? error.message : String(error));
        }
    }, [manifest, manifestHash, pluginId, router]);

    const topInset = 'topContentInset' in context ? context.topContentInset ?? 0 : 0;
    const bottomInset = 'bottomContentInset' in context ? context.bottomContentInset ?? 0 : 0;
    const onScroll = 'onScroll' in context ? context.onScroll : undefined;
    const emptyTitle = collectionEmptyTitle(failed, contribution);
    const emptyMessage = collectionEmptyMessage(failed, contribution);
    const showingSpinner = loading && groups.length === 0;
    const showingEmpty = groups.length === 0;

    return <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background }}>
        {showingSpinner && (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: topInset }}>
                <ActivityIndicator size="large" color={theme.colors.textSecondary} />
            </View>
        )}
        {!showingSpinner && showingEmpty && (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, paddingTop: topInset }}>
                <Ionicons name={(contribution.icon ?? 'albums-outline') as never} size={56} color={theme.colors.textSecondary} style={{ marginBottom: 16 }} />
                <Text style={{ color: theme.colors.text, fontSize: 20, textAlign: 'center', marginBottom: 8, ...Typography.default('semiBold') }}>{emptyTitle}</Text>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 16, lineHeight: 22, textAlign: 'center', ...Typography.default() }}>{emptyMessage}</Text>
                {failed && <Pressable onPress={() => void load(true)} accessibilityRole="button" accessibilityLabel={t('plugins.retryItems')} style={{ marginTop: 16, paddingHorizontal: 16, paddingVertical: 10 }}>
                    <Text style={{ color: theme.colors.textLink, fontSize: 15, ...Typography.default('semiBold') }}>{t('plugins.retry')}</Text>
                </Pressable>}
            </View>
        )}
        {!showingSpinner && !showingEmpty && (
            <ScrollView
                contentContainerStyle={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%', paddingTop: topInset, paddingBottom: safeArea.bottom + bottomInset }}
                onScroll={onScroll}
                scrollEventThrottle={16}
            >
                {failed && <Pressable onPress={() => void load(true)} accessibilityRole="button" accessibilityLabel={`${t('plugins.showingStale')}. ${t('plugins.retry')}`}
                    style={{ margin: 12, padding: 10, borderRadius: 8, flexDirection: 'row', gap: 8, backgroundColor: theme.colors.surfaceHigh }}>
                    <Ionicons name="warning-outline" size={16} color={theme.colors.textDestructive} />
                    <Text style={{ color: theme.colors.textDestructive, flex: 1 }}>{t('plugins.stale')}</Text>
                    <Text style={{ color: theme.colors.textLink }}>{t('plugins.retry')}</Text>
                </Pressable>}
                {groups.map((group, groupIndex) => <ItemGroup key={`${group.id}:${groupIndex}`} title={group.title}>
                    {group.items.map((item, itemIndex) => <Pressable
                        key={`${item.id}:${itemIndex}`}
                        onPress={() => void openItem(item)}
                        accessibilityRole="button"
                        accessibilityLabel={collectionItemLabel(item)}
                        style={({ pressed }) => [{
                            flexDirection: 'row',
                            alignItems: 'center',
                            paddingHorizontal: 16,
                            paddingVertical: 14,
                            backgroundColor: theme.colors.surface,
                            // Settled work steps back so the row still working keeps the contrast.
                            opacity: item.status === 'positive' ? 0.75 : 1,
                            borderBottomWidth: itemIndex === group.items.length - 1 ? 0 : StyleSheet.hairlineWidth,
                            borderBottomColor: theme.colors.divider,
                        }, pressed && { backgroundColor: theme.colors.surfacePressed }]}
                    >
                        <View style={{ marginRight: 12 }}><ItemVisual item={item} /></View>
                        <View style={{ flex: 1, minWidth: 0, paddingRight: 12 }}>
                            <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 17, ...Typography.default('semiBold') }}>{item.title}</Text>
                            {item.subtitle !== undefined && <Text numberOfLines={2} style={{ color: theme.colors.textSecondary, fontSize: 15, marginTop: 4, ...Typography.default() }}>{item.subtitle}</Text>}
                            {(item.glyph !== undefined || item.timestamp !== undefined) && <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 4, ...Typography.default() }}>
                                {[item.glyph, item.timestamp === undefined ? undefined : relativeTime(item.timestamp)].filter(Boolean).join(' · ')}
                            </Text>}
                        </View>
                        {item.status !== undefined && <StatusDot color={toneColor(theme, item.status)} isPulsing={item.pulsing === true} size={8} style={{ marginLeft: 10 }} />}
                    </Pressable>)}
                </ItemGroup>)}
            </ScrollView>
        )}
    </View>;
}
