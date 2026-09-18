import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { cardStyle, Meter, SectionLabel, withAlpha } from '@/components/ui';
import { Typography } from '@/constants/Typography';
import { pluginSnapshot, pluginHref, toneColor, useSlotContributions } from '@/plugins';
import type { PluginLimitsWindow } from '@/plugins/limits';
import { VERDICT_KEYS, usePluginCall, verdictTone } from '@/plugins/ui';
import { t } from '@/text';
import { compactAge } from '../domain/agentPresentation';
import { asRightNowPayload, rightNowBinding, vitalsFacts, type RightNowPayload } from '../domain/rightNowModel';

/** The card has no refresh of its own and the Usage screen is where live
 *  detail lives, so a few minutes behind is normal here and says nothing.
 *  Past this the age is worth a quiet word -- never an alarm. */
const AGE_WORTH_MENTIONING_SECONDS = 600;

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
    // The last-known card survives a transient failure; only a load with
    // nothing to show becomes the retry card.
    const { value: payload, failed, retry } = usePluginCall(binding, asRightNowPayload);

    if (binding === undefined) return null;
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
            <Pressable onPress={retry} accessibilityRole="button" accessibilityLabel={t('plugins.rightNow.unavailable')}
                style={[cardStyle(theme), { marginHorizontal: 16, padding: 14 }]}>
                {line}
            </Pressable>
        </View>;
    }

    if (payload === undefined) return null;
    const agedFor = disclosedAge(payload);
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
            {agedFor !== undefined && <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18 }}>{` · ${t('components.sessionStatusBar.limitAsOf', { age: agedFor })}`}</Text>}
            {open !== undefined && <View style={{ marginLeft: 'auto' }}>
                <Ionicons name="chevron-forward" size={14} color={withAlpha(theme.colors.textSecondary, 0.6)} />
            </View>}
        </View>
        : <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {failed && staleMark}
            <Text style={{ flexShrink: 1, color: failed ? theme.colors.textDestructive : theme.colors.textSecondary, fontSize: 13, lineHeight: 18 }}>
                {payload.collecting === true ? t('plugins.rightNow.collecting') : emptyLine(payload)}
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

/** The age of the limit figures, once it is old enough to be worth saying. */
function disclosedAge(payload: RightNowPayload): string | undefined {
    return payload.ageSeconds === undefined || payload.ageSeconds < AGE_WORTH_MENTIONING_SECONDS
        ? undefined
        : compactAge(payload.ageSeconds * 1_000);
}

/** With no window to show: the host's own reason when it has one -- an expired
 *  token is not a plan that was never connected -- otherwise the phone's word. */
function emptyLine(payload: RightNowPayload): string {
    return payload.limits.message ?? t('plugins.rightNow.notConnected');
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
        const agedFor = disclosedAge(payload);
        parts.push([
            line,
            ...(limit.resetsIn === undefined ? [] : [t('plugins.rightNow.resetsIn', { time: limit.resetsIn })]),
            ...(agedFor === undefined ? [] : [t('components.sessionStatusBar.limitAsOf', { age: agedFor })]),
        ].join(', '));
    } else if (payload.collecting === true) {
        parts.push(t('plugins.rightNow.collecting'));
    } else {
        parts.push(emptyLine(payload));
    }
    if (payload.vitals !== undefined) {
        parts.push(vitalsFigures(payload.vitals, (percent) => t('plugins.limits.percentUsed', { percent })).join(', '));
    }
    parts.push(t('plugins.rightNow.opensUsage'));
    return parts.join('. ');
}
