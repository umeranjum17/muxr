import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { PLUGIN_CALL_CLIENT_TIMEOUT_MS } from '@muxr/contract';
import type { PluginScreenTone } from '@muxr/contract';
import { cardStyle, Meter, SectionLabel, withAlpha } from '@/components/ui';
import { Typography } from '@/constants/Typography';
import { sync } from '@/catalog/sync';
import { pluginSnapshot, subscribePluginDataInvalidation, pluginHref, toneColor, useSlotContributions } from '@/plugins';
import { VERDICT_KEYS } from '@/plugins/ui';
import { t } from '@/text';
import { asRightNowPayload, rightNowBinding, vitalsFacts, type RightNowPayload } from '../domain/rightNowModel';

const limitTone = (verdict: NonNullable<RightNowPayload['limit']>['verdict']): PluginScreenTone | undefined =>
    verdict === 'go' ? 'positive'
        : verdict === 'watch' || verdict === 'ahead' ? 'warning'
            : verdict === 'unknown' ? undefined
                : 'danger';

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
    const binding = rightNowBinding(pluginSnapshot());
    const [state, setState] = React.useState<{ payload?: RightNowPayload; failed: boolean }>({ failed: false });
    const version = React.useRef(0);
    const load = React.useCallback(() => {
        if (binding === undefined) return;
        const request = ++version.current;
        void sync.request('plugin.call', {
            pluginId: binding.pluginId,
            manifestHash: binding.manifestHash,
            contributionId: binding.contributionId,
        }, PLUGIN_CALL_CLIENT_TIMEOUT_MS)
            .then((result) => {
                if (request !== version.current) return;
                setState({ payload: asRightNowPayload(result), failed: false });
            })
            .catch(() => {
                // Keep the last-known card through transient failures; only a
                // load with nothing to show becomes the retry card.
                if (request === version.current) setState((current) => ({ ...current, failed: true }));
            });
    }, [binding]);
    React.useEffect(() => {
        if (binding === undefined) return;
        load();
        const unsubscribe = subscribePluginDataInvalidation(binding.pluginId, load);
        return () => { version.current += 1; unsubscribe(); };
    }, [binding, load]);

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
    const limit = payload.limit;
    const verdictWord = limit === undefined || limit.verdict === 'unknown' ? undefined : t(VERDICT_KEYS[limit.verdict]);
    const tone = limit === undefined ? undefined : limitTone(limit.verdict);
    const line = limit !== undefined
        ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {tone !== undefined && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: toneColor(theme, tone) }} />}
            <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.text, fontSize: 13, lineHeight: 18 }}>
                {[verdictWord, `${limit.label} ${Math.round(limit.used)}%`].filter((part) => part !== undefined).join(' · ')}
            </Text>
            {limit.resetsIn !== undefined && <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18 }}>{` · ${t('plugins.rightNow.resetsIn', { time: limit.resetsIn })}`}</Text>}
            <View style={{ marginLeft: 'auto' }}>
                <Ionicons name="chevron-forward" size={14} color={withAlpha(theme.colors.textSecondary, 0.6)} />
            </View>
        </View>
        : <Text style={{ color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18 }}>
            {payload.collecting === true ? t('plugins.rightNow.collecting') : t('plugins.rightNow.notConnected')}
        </Text>;
    return <View>
        {label}
        {open !== undefined
            ? <Pressable onPress={open} accessibilityRole="button" accessibilityLabel={cardAccessibilityLabel(payload)}>
                <CardBody limit={limit} line={line} vitals={payload.vitals} />
            </Pressable>
            : <CardBody limit={limit} line={line} vitals={payload.vitals} />}
    </View>;
}

function CardBody({ limit, line, vitals }: { limit: RightNowPayload['limit']; line: React.ReactNode; vitals: RightNowPayload['vitals'] }) {
    const { theme } = useUnistyles();
    return <View style={[cardStyle(theme), { marginHorizontal: 16, padding: 14 }]}>
        {line}
        {limit !== undefined && <Meter ratio={limit.used / 100} emphasis={0.9} marker={limit.elapsed} style={{ marginTop: 8, marginBottom: 10 }} />}
        {vitals !== undefined && (limit !== undefined
            ? <FactsLine vitals={vitals} />
            : <FactsLine vitals={vitals} style={{ marginTop: 10 }} />)}
    </View>;
}

/** One mono line of machine figures, in the card's quiet voice: a machine at
 *  80% memory is a machine at work, not a warning. */
function FactsLine({ vitals, style }: { vitals: NonNullable<RightNowPayload['vitals']>; style?: object }) {
    const { theme } = useUnistyles();
    const { memoryPercent, diskPercent, load, uptime } = vitalsFacts(vitals);
    return (
        <Text style={[{ color: theme.colors.textSecondary, fontSize: 11.5, lineHeight: 15, ...Typography.mono('regular') }, style]}>
            {`${t('plugins.rightNow.memory')} ${memoryPercent}% · ${t('plugins.rightNow.disk')} ${diskPercent}% · ${t('plugins.rightNow.load')} ${load} · ${t('plugins.rightNow.up')} ${uptime}`}
        </Text>
    );
}

/** One sentence for the reader; the dots are decorative. */
function cardAccessibilityLabel(payload: RightNowPayload): string {
    const parts: string[] = [t('plugins.rightNow.title')];
    const limit = payload.limit;
    if (limit !== undefined) {
        const verdict = limit.verdict === 'unknown' ? undefined : t(VERDICT_KEYS[limit.verdict]);
        const line = [verdict, [limit.label, t('plugins.limits.percentUsed', { percent: Math.round(limit.used) })].join(' ')]
            .filter((part) => part !== undefined).join(', ');
        parts.push(limit.resetsIn === undefined ? line : `${line}, ${t('plugins.rightNow.resetsIn', { time: limit.resetsIn })}`);
    } else if (payload.collecting === true) {
        parts.push(t('plugins.rightNow.collecting'));
    } else {
        parts.push(t('plugins.rightNow.notConnected'));
    }
    if (payload.vitals !== undefined) {
        const { memoryPercent, diskPercent, load, uptime } = vitalsFacts(payload.vitals);
        parts.push([
            `${t('plugins.rightNow.memory')} ${t('plugins.limits.percentUsed', { percent: memoryPercent })}`,
            `${t('plugins.rightNow.disk')} ${t('plugins.limits.percentUsed', { percent: diskPercent })}`,
            `${t('plugins.rightNow.load')} ${load}`,
            `${t('plugins.rightNow.up')} ${uptime}`,
        ].join(', '));
    }
    parts.push(t('plugins.rightNow.opensUsage'));
    return parts.join('. ');
}
