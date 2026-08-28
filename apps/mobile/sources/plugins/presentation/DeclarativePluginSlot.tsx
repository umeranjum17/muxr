import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { OptionSheet } from '@/components/OptionSheet';
import { useUnistyles } from 'react-native-unistyles';
import type { PluginDataCard, PluginNativeContribution, PluginNavigationItem, PluginTerminalKeyRow } from '@muxr/contract';
import { MAX_RPC_DISPLAY_BYTES, PLUGIN_CALL_CLIENT_TIMEOUT_MS, capUtf8Bytes, sanitizeDisplayText } from '@muxr/contract';
import type { PluginTerminalChannel } from '../domain/slotTypes';
import { sync } from '@/sync/sync';
import { useSlotContributions } from '../application/useSlotContributions';
import { pluginSnapshot } from '../application/pluginStore';
import { pluginHref } from '../domain/pluginHref';
import { dispatchPluginAction } from '../application/pluginActions';
import { Modal } from '@/modal';
import { subscribePluginDataInvalidation } from '../application/pluginDataInvalidation';
import { resolvePluginText } from '../domain/pluginText';
import { t } from '@/text';
import { ItemList } from './primitives/ItemList';
import { CapabilityButton } from './primitives/CapabilityButton';

function keyRowSend(key: PluginTerminalKeyRow['keys'][number], ctrl: boolean, shift: boolean): string {
    if (ctrl && shift) return key.ctrlShift ?? key.ctrl ?? key.shift ?? key.send;
    if (ctrl) return key.ctrl ?? key.send;
    if (shift) return key.shift ?? key.send;
    return key.send;
}

function KeyRow({ contribution, channel }: { contribution: PluginTerminalKeyRow; channel?: PluginTerminalChannel }) {
    const { theme } = useUnistyles();
    const [ctrl, setCtrl] = React.useState(false);
    const [shift, setShift] = React.useState(false);
    const style = (selected = false) => ({
        minWidth: 44,
        minHeight: 40,
        justifyContent: 'center' as const,
        alignItems: 'center' as const,
        paddingHorizontal: 10,
        paddingVertical: 9,
        borderRadius: 6,
        backgroundColor: selected ? theme.colors.accent : theme.colors.surfaceHigh,
    });
    return (
        <>
            <Pressable
                onPress={() => setCtrl(!ctrl)}
                accessibilityRole="button"
                accessibilityLabel="Control"
                accessibilityState={{ selected: ctrl }}
                style={({ pressed }) => [style(ctrl), pressed && { opacity: 0.6 }]}
            >
                <Text style={{ color: ctrl ? theme.colors.button.primary.tint : theme.colors.text }}>ctrl</Text>
            </Pressable>
            <Pressable
                onPress={() => setShift(!shift)}
                accessibilityRole="button"
                accessibilityLabel="Shift"
                accessibilityState={{ selected: shift }}
                style={({ pressed }) => [style(shift), pressed && { opacity: 0.6 }]}
            >
                <Text style={{ color: shift ? theme.colors.button.primary.tint : theme.colors.text }}>shift</Text>
            </Pressable>
            {contribution.keys.map((key) => (
                <Pressable
                    key={resolvePluginText(key.label)}
                    accessibilityRole="button"
                    accessibilityLabel={resolvePluginText(key.accessibilityLabel)}
                    onPress={() => {
                        channel?.sendText(keyRowSend(key, ctrl, shift));
                        setCtrl(false);
                        setShift(false);
                    }}
                    style={({ pressed }) => [style(), pressed && { opacity: 0.6 }]}
                >
                    <Text style={{ color: theme.colors.text }}>{resolvePluginText(key.label)}</Text>
                </Pressable>
            ))}
        </>
    );
}

function useDataValue(pluginId: string, manifestHash: string, contributionId: string): { value?: string; failed: boolean; retry: () => void } {
    const [value, setValue] = React.useState<string>();
    const [failed, setFailed] = React.useState(false);
    const loading = React.useRef(false);
    const queued = React.useRef(false);
    const requestVersion = React.useRef(0);
    const latestLoad = React.useRef<() => void>(() => {});
    const load = React.useCallback(() => {
        if (loading.current) { queued.current = true; return; }
        loading.current = true;
        const version = ++requestVersion.current;
        void sync.request('plugin.call', { pluginId, manifestHash, contributionId }, PLUGIN_CALL_CLIENT_TIMEOUT_MS)
            .then((result) => {
                if (version === requestVersion.current) {
                    setValue(capUtf8Bytes(sanitizeDisplayText(typeof result === 'string' ? result : JSON.stringify(result)), MAX_RPC_DISPLAY_BYTES));
                    setFailed(false);
                }
            })
            .catch(() => { if (version === requestVersion.current) setFailed(true); })
            .finally(() => {
                if (version !== requestVersion.current) return;
                loading.current = false;
                if (queued.current) { queued.current = false; setTimeout(() => { if (version === requestVersion.current) latestLoad.current(); }, 0); }
            });
    }, [contributionId, manifestHash, pluginId]);
    latestLoad.current = load;
    React.useEffect(() => {
        load();
        return () => { requestVersion.current += 1; loading.current = false; queued.current = false; };
    }, [load]);
    React.useEffect(() => subscribePluginDataInvalidation(pluginId, load), [load, pluginId]);
    return { value, failed, retry: load };
}

function useBadgeCount(pluginId: string, manifestHash: string, source: PluginNavigationItem['badge']): number {
    const [count, setCount] = React.useState(0);
    const version = React.useRef(0);
    const loading = React.useRef(false);
    const queued = React.useRef(false);
    const latestLoad = React.useRef<() => void>(() => {});
    const load = React.useCallback(() => {
        if (source === undefined) { setCount(0); return; }
        if (loading.current) { queued.current = true; return; }
        loading.current = true;
        const request = ++version.current;
        void sync.request('plugin.call', { pluginId, manifestHash, contributionId: source.contributionId }, PLUGIN_CALL_CLIENT_TIMEOUT_MS)
            .then((result) => {
                if (request !== version.current) return;
                if (typeof result !== 'object' || result === null) { setCount(0); return; }
                const value = (result as Record<string, unknown>).count;
                setCount(typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? Math.min(value, 999) : 0);
            })
            .catch(() => { /* retain the last-known badge through transient failures */ })
            .finally(() => {
                if (request !== version.current) return;
                loading.current = false;
                if (queued.current) { queued.current = false; setTimeout(() => { if (request === version.current) latestLoad.current(); }, 0); }
            });
    }, [manifestHash, pluginId, source]);
    latestLoad.current = load;
    React.useEffect(() => { load(); return () => { version.current += 1; loading.current = false; queued.current = false; }; }, [load]);
    React.useEffect(() => subscribePluginDataInvalidation(pluginId, load), [load, pluginId]);
    return count;
}

function NavigationItemButton({ contribution, pluginId, manifestHash, active, onPress, compact = false }: {
    contribution: PluginNavigationItem; pluginId: string; manifestHash: string; active?: boolean; onPress: () => void; compact?: boolean;
}) {
    const { theme } = useUnistyles();
    const label = resolvePluginText(contribution.label);
    const count = useBadgeCount(pluginId, manifestHash, contribution.badge);
    const badge = count > 0 ? `${count > 99 ? '99+' : count}` : undefined;
    const compactStyle = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: active ? theme.colors.surfaceHigh : 'transparent' };
    const tabStyle = { flex: 1, alignItems: 'center' as const, paddingTop: 8, paddingBottom: 4 };
    let labelColor = theme.colors.text;
    if (active) labelColor = theme.colors.accent;
    else if (compact) labelColor = theme.colors.textSecondary;
    return <Pressable onPress={onPress} accessibilityRole={compact ? 'button' : 'tab'} accessibilityLabel={`${label}${badge === undefined ? '' : `, ${badge}`}`} hitSlop={compact ? 9 : undefined}
        accessibilityState={compact ? undefined : { selected: active === true }}
        style={compact ? compactStyle : tabStyle}>
        <View>
            <Ionicons name={contribution.icon as any} size={compact ? 15 : 24} color={active ? theme.colors.accent : theme.colors.textSecondary} />
            {badge !== undefined && <View accessibilityElementsHidden style={{ position: 'absolute', right: -13, top: -8, minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.accent }}>
                <Text style={{ color: theme.colors.button.primary.tint, fontSize: 9, fontWeight: '700' }}>{badge}</Text>
            </View>}
        </View>
        <Text style={{ color: labelColor, fontSize: compact ? 13 : 10, fontWeight: compact ? '600' : '400' }}>{label}</Text>
    </Pressable>;
}

function DataCard({ contribution, pluginId, manifestHash, pluginName }: { contribution: PluginDataCard; pluginId: string; manifestHash: string; pluginName: string }) {
    const { theme } = useUnistyles(); const data = useDataValue(pluginId, manifestHash, contribution.source.contributionId); const [open, setOpen] = React.useState(false);
    if (!data.value && contribution.emptyText === undefined && !data.failed) return null;
    let shown: string | undefined = data.value;
    if (data.failed && data.value === undefined) shown = `${t('plugins.dataUnavailable')} ${t('plugins.retry')}`;
    else if (shown === undefined && contribution.emptyText !== undefined) shown = resolvePluginText(contribution.emptyText);
    const failureLabel = `${resolvePluginText(contribution.title)}, ${t('plugins.unavailableSuffix')}. ${t('plugins.retry')}`;
    const body = <><Text style={{ color: theme.colors.textSecondary, fontSize: 11 }}>{pluginName}</Text><View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>{data.failed && <Ionicons name="warning-outline" size={14} color={theme.colors.textDestructive} />}<Text style={{ flex: 1, color: data.failed ? theme.colors.textDestructive : theme.colors.textSecondary }}>{shown}</Text></View></>;
    if (contribution.presentation === 'sheet') {
        return <View>
            <Pressable hitSlop={8} onPress={() => { if (data.failed) data.retry(); setOpen(true); }} accessibilityRole="button" accessibilityLabel={data.failed ? failureLabel : resolvePluginText(contribution.title)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: theme.colors.surfaceHigh }}>
                <Ionicons name="stats-chart-outline" size={15} color={theme.colors.text} />
                <Text style={{ color: theme.colors.text, fontSize: 13, fontWeight: '600' }}>{resolvePluginText(contribution.title)}</Text>
            </Pressable>
            <OptionSheet visible={open} title={resolvePluginText(contribution.title)} options={[]} onSelect={() => {}} onClose={() => setOpen(false)}
                body={<View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>{body}</View>} />
        </View>;
    }
    const cardStyle = { marginHorizontal: 16, marginBottom: 12, padding: 12, borderRadius: 10, backgroundColor: theme.colors.surfaceHigh };
    const card = <><Text style={{ color: theme.colors.text, fontWeight: '600' }}>{resolvePluginText(contribution.title)}</Text>{body}</>;
    if (data.failed) {
        return <Pressable onPress={data.retry} accessibilityRole="button" accessibilityLabel={failureLabel} style={cardStyle}>{card}</Pressable>;
    }
    return <View style={cardStyle}>{card}</View>;
}

export function DeclarativeTerminalKeySlot({ channel }: { channel?: PluginTerminalChannel }) {
    useSlotContributions('terminal.key-row');
    return <>{pluginSnapshot().flatMap(({ summary, manifest }) => manifest.contributions.flatMap((contribution) => 'type' in contribution && contribution.type === 'key-row' ? [<KeyRow key={`${summary.pluginId}:${contribution.id}`} contribution={contribution} channel={channel} />] : []))}</>;
}

export function DeclarativeHomeCards() {
    useSlotContributions('home.cards');
    return <>{pluginSnapshot().flatMap(({ summary, manifest }) => manifest.contributions.flatMap((contribution) => 'type' in contribution && contribution.type === 'data-card' && contribution.slot === 'home.cards' && contribution.presentation !== 'sheet' ? [<DataCard key={`${summary.pluginId}:${contribution.id}`} contribution={contribution} pluginId={summary.pluginId} manifestHash={summary.manifestHash} pluginName={summary.name} />] : []))}</>;
}

function DataActionRow({ contribution, pluginId, manifestHash }: { contribution: PluginDataCard; pluginId: string; manifestHash: string }) {
    const { theme } = useUnistyles();
    const data = useDataValue(pluginId, manifestHash, contribution.source.contributionId);
    const [open, setOpen] = React.useState(false);
    let shown = data.value;
    if (shown === undefined && data.failed) shown = t('plugins.unavailableLabel');
    else if (shown === undefined && contribution.emptyText !== undefined) shown = resolvePluginText(contribution.emptyText);
    const label = resolvePluginText(contribution.title);
    if (shown === undefined) return null;
    const failureLabel = `${label}, ${data.value === undefined ? t('plugins.unavailableSuffix') : t('plugins.showingStale')}. ${t('plugins.retry')}`;
    const style = ({ pressed = false } = {}) => ({ minHeight: 44, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh });
    const body = <>
        <Ionicons name={(contribution.icon ?? 'stats-chart-outline') as never} size={18} color={theme.colors.textSecondary} />
        <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>{label}</Text>
        {data.failed && <Ionicons name="warning-outline" size={14} color={theme.colors.textDestructive} />}
        <Text numberOfLines={1} style={{ maxWidth: 120, color: data.failed ? theme.colors.textDestructive : theme.colors.textSecondary, fontSize: 12 }}>{shown}</Text>
        {contribution.presentation === 'sheet' && <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />}
    </>;
    if (contribution.presentation !== 'sheet' && !data.failed) return <View style={style()}>{body}</View>;
    return <>
        <Pressable onPress={() => { if (data.failed) data.retry(); if (contribution.presentation === 'sheet') setOpen(true); }} accessibilityRole="button" accessibilityLabel={data.failed ? failureLabel : label} style={style}>{body}</Pressable>
        {contribution.presentation === 'sheet' && <OptionSheet visible={open} title={label} options={[]} onSelect={() => {}} onClose={() => setOpen(false)}
            body={<View style={{ paddingHorizontal: 16, paddingBottom: 12 }}><Text style={{ color: theme.colors.text, fontSize: 13, lineHeight: 20 }}>{shown}</Text></View>} />}
    </>;
}

type DeclarativeSessionAction =
    | { kind: 'screen'; key: string; label: string; icon: string; pluginId: string; contentId: string }
    | { kind: 'list'; key: string; label: string; pluginId: string; manifestHash: string; contribution: PluginNativeContribution }
    | { kind: 'capability'; key: string; label: string; pluginId: string; manifestHash: string; contribution: PluginNativeContribution }
    | { kind: 'data'; key: string; label: string; pluginId: string; manifestHash: string; contribution: PluginDataCard };

/** Labeled session tools, as rows for the terminal's Actions menu. */
export function DeclarativeSessionActions({ cwd, sessionId, onNavigate }: { cwd?: string; sessionId: string; onNavigate: () => void }) {
    const { theme } = useUnistyles();
    const router = useRouter();
    useSlotContributions('session.header.trailing');
    useSlotContributions('session.pills');
    const actions = pluginSnapshot().flatMap<DeclarativeSessionAction>(({ summary, manifest }) => manifest.contributions.flatMap<DeclarativeSessionAction>((contribution) => {
        if ('type' in contribution && contribution.type === 'screen-button' && contribution.slot === 'session.header.trailing' && cwd !== undefined && cwd !== '') {
            return [{ kind: 'screen', key: `${summary.pluginId}:${contribution.id}`, label: resolvePluginText(contribution.title), icon: contribution.icon, pluginId: summary.pluginId, contentId: contribution.contentContributionId }];
        }
        if ('type' in contribution && contribution.type === 'native' && contribution.primitive === 'item-list'
            && (contribution.slot === 'session.header.trailing' || contribution.slot === 'session.pills')) {
            return [{ kind: 'list', key: `${summary.pluginId}:${contribution.id}`, label: contribution.title === undefined ? summary.name : resolvePluginText(contribution.title), pluginId: summary.pluginId, manifestHash: summary.manifestHash, contribution }];
        }
        if ('type' in contribution && contribution.type === 'native' && contribution.primitive === 'icon-button'
            && contribution.slot === 'session.header.trailing') {
            return [{ kind: 'capability', key: `${summary.pluginId}:${contribution.id}`, label: resolvePluginText(contribution.accessibilityLabel!), pluginId: summary.pluginId, manifestHash: summary.manifestHash, contribution }];
        }
        if ('type' in contribution && contribution.type === 'data-card'
            && (contribution.slot === 'session.header.trailing' || contribution.slot === 'session.pills')) {
            return [{ kind: 'data', key: `${summary.pluginId}:${contribution.id}`, label: resolvePluginText(contribution.title), pluginId: summary.pluginId, manifestHash: summary.manifestHash, contribution }];
        }
        return [];
    })).sort((left, right) => left.label.localeCompare(right.label));
    if (actions.length === 0) return null;
    return <>{actions.map((action) => {
        if (action.kind === 'screen') return <Pressable key={action.key} accessibilityRole="button" accessibilityLabel={action.label} onPress={() => {
            onNavigate();
            router.push(pluginHref(action.pluginId, action.contentId, { sessionId }));
        }} style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
            <Ionicons name={action.icon as never} size={18} color={theme.colors.textSecondary} />
            <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>{action.label}</Text>
            <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
        </Pressable>;
        if (action.kind === 'list') return <ItemList key={action.key} context={{ sessionId }} pluginId={action.pluginId} manifestHash={action.manifestHash} contribution={action.contribution} presentation="action-row" />;
        if (action.kind === 'capability') return <View key={action.key} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh }}>
            <CapabilityButton context={{ sessionId }} pluginId={action.pluginId} manifestHash={action.manifestHash} contribution={action.contribution} onNavigate={onNavigate} />
            <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>{action.label}</Text>
        </View>;
        return <DataActionRow key={action.key} contribution={action.contribution} pluginId={action.pluginId} manifestHash={action.manifestHash} />;
    })}</>;
}

export function DeclarativeNavigationItems({ activeKey, onSelect, compact = false }: { activeKey?: string; compact?: boolean; onSelect: (key: string, pluginId: string, contentId: string, label: string) => void }) {
    useSlotContributions('navigation.primary');
    return <>{pluginSnapshot().flatMap(({ summary, manifest }) => manifest.contributions.flatMap((contribution) => 'type' in contribution && contribution.type === 'navigation-item' ? [
        <NavigationItemButton key={`${summary.pluginId}:${contribution.id}`} contribution={contribution} pluginId={summary.pluginId} manifestHash={summary.manifestHash}
            active={activeKey === `${summary.pluginId}:${contribution.id}`}
            compact={compact}
            onPress={() => onSelect(`${summary.pluginId}:${contribution.id}`, summary.pluginId, contribution.contentContributionId, resolvePluginText(contribution.label))} />,
    ] : []))}</>;
}

/**
 * Native-phone path for approved navigation destinations: a generic horizontal
 * row (no feature ids in the shell) that routes to the plugin content mount
 * with the selected plugin/content id.
 */
export function DeclarativePhoneNavRow({ onSelect }: { onSelect: (pluginId: string, contentId: string) => void }) {
    const { width } = useWindowDimensions();
    useSlotContributions('navigation.primary');
    const plugins = pluginSnapshot();
    const chipPluginIds = new Set(plugins.flatMap(({ summary, manifest }) => manifest.contributions.some((contribution) => 'type' in contribution && contribution.type === 'data-card' && contribution.slot === 'home.cards' && contribution.presentation === 'sheet') ? [summary.pluginId] : []));
    const chips = plugins.flatMap(({ summary, manifest }) => manifest.contributions.flatMap((contribution) => 'type' in contribution && contribution.type === 'data-card' && contribution.slot === 'home.cards' && contribution.presentation === 'sheet' ? [
        <DataCard key={`${summary.pluginId}:${contribution.id}`} contribution={contribution} pluginId={summary.pluginId} manifestHash={summary.manifestHash} pluginName={summary.name} />,
    ] : []));
    const items = plugins.flatMap(({ summary, manifest }) => manifest.contributions.flatMap((contribution) => 'type' in contribution && contribution.type === 'navigation-item' ? [{
        key: `${summary.pluginId}:${contribution.id}`,
        label: resolvePluginText(contribution.label),
        contribution,
        pluginId: summary.pluginId,
        manifestHash: summary.manifestHash,
        contentId: contribution.contentContributionId,
    }] : [])).sort((left, right) => Number(chipPluginIds.has(right.pluginId)) - Number(chipPluginIds.has(left.pluginId)));
    const content = <>
        {chips}
        {items.map((item) => (
            <NavigationItemButton key={item.key} contribution={item.contribution} pluginId={item.pluginId} manifestHash={item.manifestHash}
                compact onPress={() => onSelect(item.pluginId, item.contentId)} />
        ))}
    </>;
    if (width >= 560) {
        return (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10 }}>
                {content}
            </View>
        );
    }
    return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10 }}>
            {content}
        </ScrollView>
    );
}

export function DeclarativeSettingsItems() {
    const router = useRouter();
    useSlotContributions('settings.items');
    return <>{pluginSnapshot().flatMap(({ summary, manifest }) => manifest.contributions.flatMap((contribution) => 'type' in contribution && contribution.type === 'settings-item' ? [<Item key={`${summary.pluginId}:${contribution.id}`} title={resolvePluginText(contribution.label)} subtitle={contribution.subtitle === undefined ? undefined : resolvePluginText(contribution.subtitle)} icon={<Ionicons name={contribution.icon as any} size={29} color="#666" />} onPress={() => {
        void dispatchPluginAction(contribution.action, { router, pluginId: summary.pluginId, manifestHash: summary.manifestHash, manifest })
            .catch((error: unknown) => Modal.alert('Plugin action unavailable', error instanceof Error ? error.message : String(error)));
    }} />] : []))}</>;
}
