import * as React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import type { UsageConnectedProvider, UsageLimitsWindow, UsageNow } from '@muxr/contract';
import { AgentGlyph } from '@/components/AgentGlyph';
import { cardStyle, Meter, SectionLabel, withAlpha } from '@/components/ui';
import { Typography } from '@/constants/Typography';
import { toneColor } from '@/plugins';
import { VERDICT_KEYS, verdictTone } from '@/plugins/ui';
import { t } from '@/text';
import { compactAge } from '@/utils/compactAge';
import { useUsageNow } from '../application/useUsageNow';
import { vitalsFacts } from '../domain/usageModel';

/** The card has no refresh of its own and the Usage screen is where live
 *  detail lives, so a few minutes behind is normal here and says nothing.
 *  Past this the age is worth a quiet word -- never an alarm. */
const AGE_WORTH_MENTIONING_SECONDS = 600;

/**
 * The top of Home as figures: one verdict line, one neutral meter, one
 * vitals line. The section label is the title; the whole card opens the
 * Usage screen. Served by the host's typed usage.now method -- product code,
 * no plugin in the path.
 */
export function RightNowCard() {
    const { theme } = useUnistyles();
    const router = useRouter();
    // The last-known card survives a transient failure; only a load with
    // nothing to show becomes the retry card.
    const { value: payload, failed, retry } = useUsageNow();

    const open = () => router.push('/usage');
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
    const verdict = payload.limits.verdict;
    // Real quota windows for more than the selected tab turn the first row
    // into one restrained provider strip; Memory/Disk/Load/Uptime stay the
    // quiet row beneath it. A plan tab's own failure message keeps its row.
    const strip = hasConnectedStrip(payload);
    const limit = strip ? undefined : payload.limits.windows[0];
    const verdictWord = verdict === 'unknown' ? undefined : t(VERDICT_KEYS[verdict]);
    const tone = verdict === 'unknown' ? undefined : verdictTone(verdict);
    const dot = tone === undefined ? undefined : <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: toneColor(theme, tone) }} />;
    const staleMark = <Ionicons name="warning-outline" size={14} color={theme.colors.textDestructive} />;
    const line = strip
        ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {failed && staleMark}
            <ConnectedStrip providers={payload.connected!} />
        </View>
        : limit !== undefined
        ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {failed ? staleMark : dot}
            <Text numberOfLines={1} style={{ color: failed ? theme.colors.textDestructive : theme.colors.text, fontSize: 13, lineHeight: 18 }}>
                {[verdictWord, `${limit.label} ${Math.round(limit.used)}%`].filter((part) => part !== undefined).join(' · ')}
            </Text>
            {limit.resetsIn !== undefined && <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18 }}>{` · ${t('plugins.rightNow.resetsIn', { time: limit.resetsIn })}`}</Text>}
            <View style={{ marginLeft: 'auto' }}>
                <Ionicons name="chevron-forward" size={14} color={withAlpha(theme.colors.textSecondary, 0.6)} />
            </View>
        </View>
        : <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {failed && staleMark}
            <Text style={{ flexShrink: 1, color: failed ? theme.colors.textDestructive : theme.colors.textSecondary, fontSize: 13, lineHeight: 18 }}>
                {payload.collecting === true ? t('plugins.rightNow.collecting') : emptyLine(payload)}
            </Text>
        </View>;
    return <View>
        {label}
        <Pressable onPress={open} accessibilityRole="button" accessibilityLabel={cardAccessibilityLabel(payload, failed)}>
            <CardBody limit={limit} line={line} quiet={quietLine(payload)} />
        </Pressable>
    </View>;
}

function CardBody({ limit, line, quiet }: { limit?: UsageLimitsWindow; line: React.ReactNode; quiet: string[] }) {
    const { theme } = useUnistyles();
    return <View style={[cardStyle(theme), { marginHorizontal: 16, padding: 14 }]}>
        {line}
        {limit !== undefined && <Meter ratio={limit.used / 100} emphasis={0.9} marker={limit.elapsed} style={{ marginTop: 8, marginBottom: 10 }} />}
        {quiet.length > 0 && <FactsLine parts={quiet} style={limit === undefined ? { marginTop: 10 } : undefined} />}
    </View>;
}

/** One tiny mark per connected provider beside a compact stack of the real
 *  remaining percentages for its quota windows -- the machine's plans at a
 *  glance, not a second Usage screen. A horizontal row scrolls instead of
 *  wrapping, so a 270 dp viewport keeps the vitals line on screen. */
function ConnectedStrip({ providers }: { providers: UsageConnectedProvider[] }) {
    const { theme } = useUnistyles();
    return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 14, paddingRight: 4 }}>
            {providers.map((provider) => (
                <View key={provider.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}
                    accessibilityLabel={providerSummary(provider)}>
                    <AgentGlyph name={provider.glyph ?? provider.id} size={16} />
                    <View>
                        {provider.windows.map((window, index) => (
                            <Text key={index} style={{ color: theme.colors.text, fontSize: 11.5, lineHeight: 13, ...Typography.mono('regular') }}>
                                {`${100 - window.used}%`}
                            </Text>
                        ))}
                    </View>
                </View>
            ))}
        </ScrollView>
    );
}

/** The strip answers only when the payload itself leads with a real window:
 *  a plan tab's own failure keeps its honest row. */
function hasConnectedStrip(payload: UsageNow): boolean {
    return (payload.connected?.length ?? 0) > 0 && payload.limits.windows.length > 0;
}

/** One sentence per provider for the reader: "OpenCode Go: 100% left, 32% left". */
function providerSummary(provider: UsageConnectedProvider): string {
    return t('plugins.rightNow.planRemaining', {
        plan: provider.plan ?? provider.label,
        remainings: provider.windows.map((window) => t('plugins.limits.percentLeft', { percent: 100 - window.used })).join(', '),
    });
}

/** One mono line in the card's quiet voice: a machine at 80% memory is a
 *  machine at work, not a warning, and figures a few minutes old are still
 *  the answer -- so how old they are belongs here, not beside the verdict. */
function FactsLine({ parts, style }: { parts: string[]; style?: object }) {
    const { theme } = useUnistyles();
    return (
        <Text style={[{ color: theme.colors.textSecondary, fontSize: 11.5, lineHeight: 15, ...Typography.mono('regular') }, style]}>
            {parts.join(' · ')}
        </Text>
    );
}

/** The quiet line: the machine's figures, then the age of the limit figures
 *  above once it is old enough to be worth saying. */
function quietLine(payload: UsageNow, percent = (value: number) => `${value}%`): string[] {
    const agedFor = disclosedAge(payload);
    return [
        ...(payload.vitals === undefined ? [] : vitalsFigures(payload.vitals, percent)),
        ...(agedFor === undefined ? [] : [t('components.sessionStatusBar.limitAsOf', { age: agedFor })]),
    ];
}

/** The figures the host could read, in order; a filesystem it could not stat
 *  drops its own figure and leaves the rest of the line standing. */
function vitalsFigures(vitals: NonNullable<UsageNow['vitals']>, percent = (value: number) => `${value}%`): string[] {
    const facts = vitalsFacts(vitals);
    if (facts === undefined) return [];
    const { memoryPercent, diskPercent, load, uptime } = facts;
    return [
        `${t('plugins.rightNow.memory')} ${percent(memoryPercent)}`,
        ...(diskPercent === undefined ? [] : [`${t('plugins.rightNow.disk')} ${percent(diskPercent)}`]),
        `${t('plugins.rightNow.load')} ${load}`,
        `${t('plugins.rightNow.up')} ${uptime}`,
    ];
}

/** The age of the limit figures, once it is old enough to be worth saying. */
function disclosedAge(payload: UsageNow): string | undefined {
    return payload.ageSeconds === undefined || payload.ageSeconds < AGE_WORTH_MENTIONING_SECONDS
        ? undefined
        : compactAge(payload.ageSeconds * 1_000);
}

/** With no window to show: the host's own reason when it has one -- an expired
 *  token is not a plan that was never connected -- otherwise the phone's word. */
function emptyLine(payload: UsageNow): string {
    return payload.limits.message ?? t('plugins.rightNow.notConnected');
}

/** One sentence for the reader; the dots are decorative. */
function cardAccessibilityLabel(payload: UsageNow, stale: boolean): string {
    const parts: string[] = [t('plugins.rightNow.title')];
    if (stale) parts.push(t('plugins.showingStale'));
    if (hasConnectedStrip(payload)) {
        parts.push(payload.connected!.map(providerSummary).join(', '));
    } else if (payload.limits.windows[0] !== undefined) {
        const limit = payload.limits.windows[0];
        const verdict = payload.limits.verdict === 'unknown' ? undefined : t(VERDICT_KEYS[payload.limits.verdict]);
        const line = [verdict, [limit.label, t('plugins.limits.percentUsed', { percent: Math.round(limit.used) })].join(' ')]
            .filter((part) => part !== undefined).join(', ');
        parts.push(limit.resetsIn === undefined ? line : `${line}, ${t('plugins.rightNow.resetsIn', { time: limit.resetsIn })}`);
    } else if (payload.collecting === true) {
        parts.push(t('plugins.rightNow.collecting'));
    } else {
        parts.push(emptyLine(payload));
    }
    const quiet = quietLine(payload, (percent) => t('plugins.limits.percentUsed', { percent }));
    if (quiet.length > 0) parts.push(quiet.join(', '));
    parts.push(t('plugins.rightNow.opensUsage'));
    return parts.join('. ');
}
