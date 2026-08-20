import * as React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { OptionSheet } from '@/components/OptionSheet';
import { useUnistyles } from 'react-native-unistyles';
import type { PluginDataCard, PluginNavigationItem, PluginTerminalKeyRow } from '@muxr/contract';
import { MAX_RPC_DISPLAY_BYTES, PLUGIN_CALL_CLIENT_TIMEOUT_MS, capUtf8Bytes, sanitizeDisplayText } from '@muxr/contract';
import type { TerminalChannel } from '@/terminal/openTerminal';
import { sync } from '@/sync/sync';
import { useSlotContributions } from './useSlotContributions';
import { pluginSnapshot } from './pluginStore';
import { pluginHref } from './pluginHref';
import { dispatchPluginAction } from './pluginActions';
import { Modal } from '@/modal';
import { subscribePluginDataInvalidation } from './pluginDataInvalidation';
import { resolvePluginText } from './pluginText';
import { t } from '@/text';

function KeyRow({ contribution, channel }: { contribution: PluginTerminalKeyRow; channel?: TerminalChannel }) {
    const { theme } = useUnistyles();
    const [ctrl, setCtrl] = React.useState(false); const [shift, setShift] = React.useState(false);
    const style = (selected = false) => ({ minWidth: 44, minHeight: 40, justifyContent: 'center' as const, alignItems: 'center' as const, paddingHorizontal: 10, paddingVertical: 9, borderRadius: 6, backgroundColor: selected ? theme.colors.accent : theme.colors.surfaceHigh });
    return <><Pressable onPress={() => setCtrl(!ctrl)} accessibilityRole="button" accessibilityLabel="Control" accessibilityState={{ selected: ctrl }} style={({ pressed }) => [style(ctrl), pressed && { opacity: 0.6 }]}><Text style={{ color: ctrl ? theme.colors.button.primary.tint : theme.colors.text }}>ctrl</Text></Pressable><Pressable onPress={() => setShift(!shift)} accessibilityRole="button" accessibilityLabel="Shift" accessibilityState={{ selected: shift }} style={({ pressed }) => [style(shift), pressed && { opacity: 0.6 }]}><Text style={{ color: shift ? theme.colors.button.primary.tint : theme.colors.text }}>shift</Text></Pressable>{contribution.keys.map((key) => <Pressable key={resolvePluginText(key.label)} accessibilityRole="button" accessibilityLabel={resolvePluginText(key.accessibilityLabel)} onPress={() => { channel?.sendText(ctrl && shift ? key.ctrlShift ?? key.ctrl ?? key.shift ?? key.send : ctrl ? key.ctrl ?? key.send : shift ? key.shift ?? key.send : key.send); setCtrl(false); setShift(false); }} style={({ pressed }) => [style(), pressed && { opacity: 0.6 }]}><Text style={{ color: theme.colors.text }}>{resolvePluginText(key.label)}</Text></Pressable>)}</>;
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
    return <Pressable onPress={onPress} accessibilityRole={compact ? 'button' : 'tab'} accessibilityLabel={`${label}${badge === undefined ? '' : `, ${badge}`}`} hitSlop={compact ? 9 : undefined}
        accessibilityState={compact ? undefined : { selected: active === true }}
        style={compact
            ? { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: theme.colors.surfaceHigh }
            : { flex: 1, alignItems: 'center', paddingTop: 8, paddingBottom: 4 }}>
        <View>
            <Ionicons name={contribution.icon as any} size={compact ? 15 : 24} color={active ? theme.colors.accent : theme.colors.textSecondary} />
            {badge !== undefined && <View accessibilityElementsHidden style={{ position: 'absolute', right: -13, top: -8, minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.accent }}>
                <Text style={{ color: theme.colors.button.primary.tint, fontSize: 9, fontWeight: '700' }}>{badge}</Text>
            </View>}
        </View>
        <Text style={{ color: active ? theme.colors.accent : theme.colors.text, fontSize: compact ? 13 : 10, fontWeight: compact ? '600' : '400' }}>{label}</Text>
    </Pressable>;
}

function DataCard({ contribution, pluginId, manifestHash, pluginName }: { contribution: PluginDataCard; pluginId: string; manifestHash: string; pluginName: string }) {
    const { theme } = useUnistyles(); const data = useDataValue(pluginId, manifestHash, contribution.source.contributionId); const [open, setOpen] = React.useState(false);
    if (!data.value && contribution.emptyText === undefined && !data.failed) return null;
    const shown = data.failed && data.value === undefined ? `${t('plugins.dataUnavailable')} ${t('plugins.retry')}` : data.value ?? (contribution.emptyText === undefined ? undefined : resolvePluginText(contribution.emptyText));
    const failureLabel = `${resolvePluginText(contribution.title)}, ${t('plugins.unavailableSuffix')}. ${t('plugins.retry')}`;
    const body = <><Text style={{ color: theme.colors.textSecondary, fontSize: 11 }}>{pluginName}</Text><View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>{data.failed && <Ionicons name="warning-outline" size={14} color={theme.colors.textDestructive} />}<Text style={{ flex: 1, color: data.failed ? theme.colors.textDestructive : theme.colors.textSecondary }}>{shown}</Text></View></>;
    if (contribution.presentation === 'sheet') {
        return <View>
            <Pressable onPress={() => { if (data.failed) data.retry(); setOpen(true); }} accessibilityRole="button" accessibilityLabel={data.failed ? failureLabel : resolvePluginText(contribution.title)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: theme.colors.surfaceHigh }}>
                <Ionicons name="stats-chart-outline" size={15} color={theme.colors.text} />
                <Text style={{ color: theme.colors.text, fontSize: 13, fontWeight: '600' }}>{resolvePluginText(contribution.title)}</Text>
            </Pressable>
            <OptionSheet visible={open} title={resolvePluginText(contribution.title)} options={[]} onSelect={() => {}} onClose={() => setOpen(false)}
                body={<View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>{body}</View>} />
        </View>;
    }
    const cardStyle = { marginHorizontal: 16, marginBottom: 12, padding: 12, borderRadius: 10, backgroundColor: theme.colors.surfaceHigh };
    return data.failed
        ? <Pressable onPress={data.retry} accessibilityRole="button" accessibilityLabel={failureLabel} style={cardStyle}><Text style={{ color: theme.colors.text, fontWeight: '600' }}>{resolvePluginText(contribution.title)}</Text>{body}</Pressable>
        : <View style={cardStyle}><Text style={{ color: theme.colors.text, fontWeight: '600' }}>{resolvePluginText(contribution.title)}</Text>{body}</View>;
}

export function DeclarativeTerminalKeySlot({ channel }: { channel?: TerminalChannel }) {
    useSlotContributions('terminal.key-row');
    return <>{pluginSnapshot().flatMap(({ summary, manifest }) => manifest.contributions.flatMap((contribution) => 'type' in contribution && contribution.type === 'key-row' ? [<KeyRow key={`${summary.pluginId}:${contribution.id}`} contribution={contribution} channel={channel} />] : []))}</>;
}

export function DeclarativeHomeCards() {
    useSlotContributions('home.cards');
    return <>{pluginSnapshot().flatMap(({ summary, manifest }) => manifest.contributions.flatMap((contribution) => 'type' in contribution && contribution.type === 'data-card' && contribution.slot === 'home.cards' && contribution.presentation !== 'sheet' ? [<DataCard key={`${summary.pluginId}:${contribution.id}`} contribution={contribution} pluginId={summary.pluginId} manifestHash={summary.manifestHash} pluginName={summary.name} />] : []))}</>;
}

/** Compact read-only chip: the same data-card contribution rendered for a header or pill row. */
function DataChip({ contribution, pluginId, manifestHash }: { contribution: PluginDataCard; pluginId: string; manifestHash: string }) {
    const { theme } = useUnistyles(); const data = useDataValue(pluginId, manifestHash, contribution.source.contributionId);
    const [open, setOpen] = React.useState(false);
    const shown = data.value ?? (data.failed ? t('plugins.unavailableLabel') : contribution.emptyText === undefined ? undefined : resolvePluginText(contribution.emptyText));
    const label = resolvePluginText(contribution.title);
    const failureLabel = `${label}, ${data.value === undefined ? t('plugins.unavailableSuffix') : t('plugins.showingStale')}. ${t('plugins.retry')}`;
    if (shown === undefined) return null;
    // A header has room for one control, not a sentence: icon opens the detail.
    if (contribution.presentation === 'sheet') {
        return <>
            <Pressable onPress={() => { if (data.failed) data.retry(); setOpen(true); }} accessibilityRole="button" accessibilityLabel={data.failed ? failureLabel : label} hitSlop={8}
                style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 999, backgroundColor: theme.colors.surfaceHigh }}>
                <Ionicons name={(contribution.icon ?? 'stats-chart-outline') as any} size={16} color={theme.colors.textSecondary} />
            </Pressable>
            <OptionSheet visible={open} title={resolvePluginText(contribution.title)} options={[]} onSelect={() => {}} onClose={() => setOpen(false)}
                body={<View style={{ paddingHorizontal: 16, paddingBottom: 12 }}><Text style={{ color: theme.colors.text, fontSize: 13, lineHeight: 20 }}>{shown}</Text></View>} />
        </>;
    }
    // Chips sit in a dense row next to native controls, so one bounded line only.
    const chipBody = <><Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 11, fontWeight: '600', maxWidth: 160 }}>{label}</Text>{data.failed && <Ionicons name="warning-outline" size={12} color={theme.colors.textDestructive} />}<Text numberOfLines={1} style={{ color: data.failed ? theme.colors.textDestructive : theme.colors.text, fontSize: 11, maxWidth: 160 }}>{shown}</Text></>;
    const chipStyle = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 4, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, backgroundColor: theme.colors.surfaceHigh };
    return data.failed
        ? <Pressable onPress={data.retry} accessibilityRole="button" accessibilityLabel={failureLabel} hitSlop={14} style={chipStyle}>{chipBody}</Pressable>
        : <View style={chipStyle}>{chipBody}</View>;
}

/**
 * Header icon that opens a plugin screen for the session's directory. The screen
 * travels with the session id, not the path: the host replaces a caller-supplied
 * cwd with the one it holds for that session, so a path sent from here is
 * dropped and the screen opens with no repository.
 */
export function DeclarativeHeaderButtons({ cwd, sessionId }: { cwd?: string; sessionId: string }) {
    const { theme } = useUnistyles();
    const router = useRouter();
    useSlotContributions('session.header.trailing');
    if (cwd === undefined || cwd === '') return null;
    return <>{pluginSnapshot().flatMap(({ summary, manifest }) => manifest.contributions.flatMap((contribution) => 'type' in contribution && contribution.type === 'screen-button' ? [
        <Pressable key={`${summary.pluginId}:${contribution.id}`} accessibilityRole="button" accessibilityLabel={resolvePluginText(contribution.title)} hitSlop={8}
            onPress={() => router.push(pluginHref(summary.pluginId, contribution.contentContributionId, { sessionId }))}
            style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 999, backgroundColor: theme.colors.surfaceHigh }}>
            <Ionicons name={contribution.icon as any} size={16} color={theme.colors.textSecondary} />
        </Pressable>,
    ] : []))}</>;
}

/** Declarative chips for a compact slot; renders nothing when no plugin claims it. */
export function DeclarativeChips({ slot }: { slot: 'session.header.trailing' | 'session.pills' }) {
    useSlotContributions(slot);
    return <>{pluginSnapshot().flatMap(({ summary, manifest }) => manifest.contributions.flatMap((contribution) => 'type' in contribution && contribution.type === 'data-card' && contribution.slot === slot ? [<DataChip key={`${summary.pluginId}:${contribution.id}`} contribution={contribution} pluginId={summary.pluginId} manifestHash={summary.manifestHash} />] : []))}</>;
}

export function DeclarativeNavigationItems({ activeKey, onSelect }: { activeKey?: string; onSelect: (key: string, pluginId: string, contentId: string, label: string) => void }) {
    useSlotContributions('navigation.primary');
    return <>{pluginSnapshot().flatMap(({ summary, manifest }) => manifest.contributions.flatMap((contribution) => 'type' in contribution && contribution.type === 'navigation-item' ? [
        <NavigationItemButton key={`${summary.pluginId}:${contribution.id}`} contribution={contribution} pluginId={summary.pluginId} manifestHash={summary.manifestHash}
            active={activeKey === `${summary.pluginId}:${contribution.id}`}
            onPress={() => onSelect(`${summary.pluginId}:${contribution.id}`, summary.pluginId, contribution.contentContributionId, resolvePluginText(contribution.label))} />,
    ] : []))}</>;
}

/**
 * Native-phone path for approved navigation destinations: a generic horizontal
 * row (no feature ids in the shell) that routes to the plugin content mount
 * with the selected plugin/content id.
 */
export function DeclarativePhoneNavRow({ onSelect }: { onSelect: (pluginId: string, contentId: string) => void }) {
    const { theme } = useUnistyles();
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
    if (chips.length === 0 && items.length === 0) return null;
    return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10 }}>
            {chips}
            {items.map((item) => (
                <NavigationItemButton key={item.key} contribution={item.contribution} pluginId={item.pluginId} manifestHash={item.manifestHash}
                    compact onPress={() => onSelect(item.pluginId, item.contentId)} />
            ))}
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
