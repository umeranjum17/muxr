import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { PLUGIN_CALL_CLIENT_TIMEOUT_MS } from '@muxr/contract';
import { cardStyle, Meter, SectionLabel, withAlpha } from '@/components/ui';
import { Typography } from '@/constants/Typography';
import { sync } from '@/catalog/sync';
import { pluginSnapshot, subscribePluginDataInvalidation, pluginHref, toneColor, useSlotContributions } from '@/plugins';
import type { PluginLimitsWindow } from '@/plugins/limits';
import { VERDICT_KEYS, verdictTone } from '@/plugins/ui';
import { t } from '@/text';
import { asRightNowPayload, rightNowBinding, vitalsFacts, type RightNowPayload } from '../domain/rightNowModel';

/**
 * The top of Home as figures: one verdict line, one neutral meter, one
 * vitals line. The section label is the title; the whole card opens the
 * Usage screen.
 */
export function RightNowCard() {
    const { theme } = useUnistyles();
    const router = useRouter();
    // Subscribes this component to manifest changes and keeps them loading.
    useSlotContributions('home.cards');
    const plugins = pluginSnapshot();
    const binding = React.useMemo(() => rightNowBinding(plugins), [plugins]);
    const [state, setState] = React.useState<{ payload?: RightNowPayload; failed: boolean }>({ failed: false });
    const pluginId = binding?.pluginId;
    const manifestHash = binding?.manifestHash;
    const contributionId = binding?.contributionId;
    const version = React.useRef(0);
    const loading = React.useRef(false);
    const queued = React.useRef(false);
    const latestLoad = React.useRef<() => void>(() => {});
    const load = React.useCallback(() => {
        if (pluginId === undefined || manifestHash === undefined || contributionId === undefined) return;
        if (loading.current) { queued.current = true; return; }
        loading.current = true;
        const request = ++version.current;
        void sync.request('plugin.call', { pluginId, manifestHash, contributionId }, PLUGIN_CALL_CLIENT_TIMEOUT_MS)
            .then((result) => {
                if (request !== version.current) return;
                setState({ payload: asRightNowPayload(result), failed: false });
            })
            .catch(() => {
                // Keep the last-known card through transient failures; only a
                // load with nothing to show becomes the retry card.
                if (request === version.current) setState((current) => ({ ...current, failed: true }));
            })
            .finally(() => {
                if (request !== version.current) return;
                loading.current = false;
                if (queued.current) { queued.current = false; setTimeout(() => { if (request === version.current) latestLoad.current(); }, 0); }
            });
    }, [contributionId, manifestHash, pluginId]);
    latestLoad.current = load;
    React.useEffect(() => {
        if (pluginId === undefined) return;
        load();
        const unsubscribe = subscribePluginDataInvalidation(pluginId, load);
        return () => { version.current += 1; loading.current = false; queued.current = false; unsubscribe(); };
    }, [load, pluginId]);

    if (binding === undefined) return null;
    const { payload, failed } = state;
    const open = binding.contentContributionId === undefined ? undefined : () =>
        router.push(pluginHref(binding.pluginId, binding.contentContributionId!) as never);
    const label = <SectionLabel style={{ marginTop: 20, marginBottom: 8, marginHorizontal: 16 }}>{t('plugins.rightNow.title')}</SectionLabel>;
    const skeleton = payload === undefined && !failed;

    if (skeleton) {
        // First paint: a card-shaped block, no text, per the spine's loading state.
        return <View>
            {label}
            <View style={{ marginHorizontal: 16, height: 64, borderRadius: 12, backgroundColor: withAlpha(theme.colors.surfaceHigh, 0.6) }} />
        </View>;
    }

    if (failed && payload === undefined) {
        const line = <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: toneColor(theme, 'danger') }} />
            <Text style={{ flexShrink: 1, color: theme.colors.text, fontSize: 13, lineHeight: 18 }}>{t('plugins.rightNow.unavailable')}</Text>
        </View>;
        return <View>
            {label}
            <Pressable onPress={load} accessibilityRole="button" accessibilityLabel={t('plugins.rightNow.unavailable')}
                style={[cardStyle(theme), { marginHorizontal: 16, padding: 14 }]}>
                {line}
            </Pressable>
        </View>;
    }

    if (payload === undefined) return null;
    const verdict = payload.limits.verdict;
    const limit = payload.limits.windows[0];
    const verdictWord = verdict === 'unknown' ? undefined : t(VERDICT_KEYS[verdict]);
    const tone = verdict === 'unknown' ? undefined : verdictTone(verdict);
    const dot = tone === undefined ? undefined : <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: toneColor(theme, tone) }} />;
    const staleMark = <Ionicons name="warning-outline" size={14} color={theme.colors.textDestructive} />;
    const line = limit !== undefined
        ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {failed ? staleMark : dot}
            <Text numberOfLines={1} style={{ flexShrink: 1, color: failed ? theme.colors.textDestructive : theme.colors.text, fontSize: 13, lineHeight: 18 }}>
                {[verdictWord, `${limit.label} ${Math.round(limit.used)}%`].filter((part) => part !== undefined).join(' · ')}
            </Text>
            {limit.resetsIn !== undefined && <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18 }}>{` · ${t('plugins.rightNow.resetsIn', { time: limit.resetsIn })}`}</Text>}
            {open !== undefined && <View style={{ marginLeft: 'auto' }}>
                <Ionicons name="chevron-forward" size={14} color={withAlpha(theme.colors.textSecondary, 0.6)} />
            </View>}
        </View>
        : <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {failed && staleMark}
            <Text style={{ flexShrink: 1, color: failed ? theme.colors.textDestructive : theme.colors.textSecondary, fontSize: 13, lineHeight: 18 }}>
                {payload.collecting === true ? t('plugins.rightNow.collecting') : t('plugins.rightNow.notConnected')}
            </Text>
        </View>;
    return <View>
        {label}
        {open !== undefined
            ? <Pressable onPress={open} accessibilityRole="button" accessibilityLabel={cardAccessibilityLabel(payload, failed)}>
                <CardBody limit={limit} line={line} vitals={payload.vitals} />
            </Pressable>
            : <CardBody limit={limit} line={line} vitals={payload.vitals} />}
    </View>;
}

function CardBody({ limit, line, vitals }: { limit?: PluginLimitsWindow; line: React.ReactNode; vitals: RightNowPayload['vitals'] }) {
    const { theme } = useUnistyles();
    return <View style={[cardStyle(theme), { marginHorizontal: 16, padding: 14 }]}>
        {line}
        {limit !== undefined && <Meter ratio={limit.used / 100} emphasis={0.9} marker={limit.elapsed} style={{ marginTop: 8, marginBottom: 10 }} />}
        {vitals !== undefined && <FactsLine vitals={vitals} style={limit === undefined ? { marginTop: 10 } : undefined} />}
    </View>;
}

/** One mono line of machine figures, in the card's quiet voice: a machine at
 *  80% memory is a machine at work, not a warning. */
function FactsLine({ vitals, style }: { vitals: NonNullable<RightNowPayload['vitals']>; style?: object }) {
    const { theme } = useUnistyles();
    return (
        <Text style={[{ color: theme.colors.textSecondary, fontSize: 11.5, lineHeight: 15, ...Typography.mono('regular') }, style]}>
            {vitalsFigures(vitals).join(' · ')}
        </Text>
    );
}

/** The figures the host could read, in order; a filesystem it could not stat
 *  drops its own figure and leaves the rest of the line standing. */
function vitalsFigures(vitals: NonNullable<RightNowPayload['vitals']>, percent = (value: number) => `${value}%`): string[] {
    const { memoryPercent, diskPercent, load, uptime } = vitalsFacts(vitals);
    return [
        `${t('plugins.rightNow.memory')} ${percent(memoryPercent)}`,
        ...(diskPercent === undefined ? [] : [`${t('plugins.rightNow.disk')} ${percent(diskPercent)}`]),
        `${t('plugins.rightNow.load')} ${load}`,
        `${t('plugins.rightNow.up')} ${uptime}`,
    ];
}

/** One sentence for the reader; the dots are decorative. */
function cardAccessibilityLabel(payload: RightNowPayload, stale: boolean): string {
    const parts: string[] = [t('plugins.rightNow.title')];
    if (stale) parts.push(t('plugins.showingStale'));
    const limit = payload.limits.windows[0];
    if (limit !== undefined) {
        const verdict = payload.limits.verdict === 'unknown' ? undefined : t(VERDICT_KEYS[payload.limits.verdict]);
        const line = [verdict, [limit.label, t('plugins.limits.percentUsed', { percent: Math.round(limit.used) })].join(' ')]
            .filter((part) => part !== undefined).join(', ');
        parts.push(limit.resetsIn === undefined ? line : `${line}, ${t('plugins.rightNow.resetsIn', { time: limit.resetsIn })}`);
    } else if (payload.collecting === true) {
        parts.push(t('plugins.rightNow.collecting'));
    } else {
        parts.push(t('plugins.rightNow.notConnected'));
    }
    if (payload.vitals !== undefined) {
        parts.push(vitalsFigures(payload.vitals, (percent) => t('plugins.limits.percentUsed', { percent })).join(', '));
    }
    parts.push(t('plugins.rightNow.opensUsage'));
    return parts.join('. ');
}
