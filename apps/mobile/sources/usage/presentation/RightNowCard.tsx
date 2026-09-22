import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import type { UsageConnectedProvider, UsageLimitsWindow } from '@muxr/contract';
import type { UsageFigures } from '../application/freshnessWindow';
import { AgentGlyph } from '@/components/AgentGlyph';
import { cardStyle, Meter, SectionLabel, withAlpha } from '@/components/ui';
import { Typography } from '@/constants/Typography';
import { toneColor } from '@/plugins';
import { VERDICT_KEYS, verdictTone } from '@/plugins/ui';
import { t } from '@/text';
import { compactAge } from '@/utils/compactAge';
import { useUsageNow } from '../application/useUsageNow';
import { vitalsFacts } from '../domain/usageModel';

/** The card refreshes itself on a slow cadence while someone is looking at it,
 *  so a few minutes behind is normal here and says nothing. Past this the age
 *  is worth a quiet word -- never an alarm. */
const AGE_WORTH_MENTIONING_SECONDS = 600;

/**
 * The top of Home as figures: each connected plan as a neutral meter with what
 * is left and when it resets, then one quieter vitals line. The section label
 * is the title and carries the refresh control; the whole card opens the
 * Usage screen. Served by the host's typed usage.now method -- product code,
 * no plugin in the path.
 */
export function RightNowCard() {
    const { theme } = useUnistyles();
    const router = useRouter();
    // The card paints one of three states and has no fourth: figures it holds, a
    // wait it is in, or a failure with the way back.
    const { display, failed, refreshing, throttledSeconds, refresh } = useUsageNow();

    const open = () => router.push('/usage');
    // The refresh control is the section's trailing action, where a control on
    // a list header lives, instead of a bare glyph under the card.
    const header = (control?: React.ReactNode) => (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16, marginBottom: 6, marginHorizontal: 16, minHeight: 24 }}>
            <SectionLabel style={{ flex: 1 }}>{t('plugins.rightNow.title')}</SectionLabel>
            {control}
        </View>
    );
    const freshness = (payload?: UsageFigures) => <FreshnessControl payload={payload} failed={failed} refreshing={refreshing} throttledSeconds={throttledSeconds} onRefresh={refresh} />;

    if (display.status === 'unavailable') {
        return <View>
            {header()}
            <Pressable onPress={refresh} accessibilityRole="button" accessibilityLabel={t('plugins.rightNow.unavailable')}
                style={[cardStyle(theme), { marginHorizontal: 16, padding: 14 }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: toneColor(theme, 'danger') }} />
                    <Text style={{ flexShrink: 1, color: theme.colors.text, fontSize: 13, lineHeight: 18 }}>{t('plugins.rightNow.unavailable')}</Text>
                </View>
                {display.reason !== '' && <Text numberOfLines={2} style={{ color: theme.colors.textSecondary, fontSize: 12, lineHeight: 16, marginTop: 4, marginLeft: 14 }}>{display.reason}</Text>}
                {vitalsFigures(display.vitals).length > 0 && <FactsLine parts={vitalsFigures(display.vitals)} style={{ marginTop: 8, marginLeft: 14 }} />}
            </Pressable>
        </View>;
    }

    if (display.status === 'waiting') {
        return <View>
            {header(freshness())}
            <View style={[cardStyle(theme), { marginHorizontal: 16, padding: 14 }]}>
                <Pressable onPress={open} accessibilityRole="button" accessibilityLabel={`${t('plugins.rightNow.collecting')}. ${t('plugins.rightNow.opensUsage')}`}>
                    <CardBody line={<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Text style={{ flexShrink: 1, color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18 }}>{t('plugins.rightNow.collecting')}</Text>
                    </View>} quiet={vitalsFigures(display.vitals)} />
                </Pressable>
            </View>
        </View>;
    }

    const payload = display.figures;
    const verdict = payload.limits.verdict;
    // Real quota windows for more than the selected tab turn the first row
    // into one restrained provider strip; Memory/Disk/Load/Uptime stay the
    // quiet row beneath it. A plan tab's own failure message keeps its row.
    const strip = hasConnectedStrip(payload);
    const limit = strip ? undefined : (payload.cardWindow ?? payload.limits.windows[0]);
    const verdictWord = verdict === 'unknown' ? undefined : t(VERDICT_KEYS[verdict]);
    const tone = verdict === 'unknown' ? undefined : verdictTone(verdict);
    const dot = tone === undefined ? undefined : <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: toneColor(theme, tone) }} />;
    // A refresh that failed says so on the refresh control above, in words and
    // with the action attached. Reddening figures that are still the best
    // known answer would report the wrong thing: they are old, not wrong.
    const line = strip
        ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ConnectedStrip providers={payload.connected!} />
        </View>
        : limit !== undefined
        ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {dot}
            <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 13, lineHeight: 18 }}>
                {[verdictWord, `${limit.label}${limit.window === undefined ? '' : ` · ${limit.window}`} ${Math.round(limit.used)}%`].filter((part) => part !== undefined).join(' · ')}
            </Text>
            {limit.resetsIn !== undefined && <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18 }}>{` · ${t('plugins.rightNow.resetsIn', { time: limit.resetsIn })}`}</Text>}
            <View style={{ marginLeft: 'auto' }}>
                <Ionicons name="chevron-forward" size={14} color={withAlpha(theme.colors.textSecondary, 0.6)} />
            </View>
        </View>
        : <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ flexShrink: 1, color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18 }}>
                {emptyLine(payload)}
            </Text>
        </View>;
    // The freshness control is a sibling of the card's own press, never inside
    // it: one control nested in another is invalid on the web surface, and on
    // any surface it makes a small target that opens a screen overlap a
    // smaller one that does not.
    return <View>
        {header(freshness(payload))}
        <View style={[cardStyle(theme), { marginHorizontal: 16, padding: 14 }]}>
            <Pressable onPress={open} accessibilityRole="button" accessibilityLabel={cardAccessibilityLabel(payload)}>
                <CardBody limit={limit} line={line} quiet={quietLine(payload)} />
            </Pressable>
        </View>
    </View>;
}

/** The plan figures, then the machine's own under a hairline: two kinds of
 *  fact, and the machine's is the quieter one. */
function CardBody({ limit, line, quiet }: { limit?: UsageLimitsWindow; line: React.ReactNode; quiet: string[] }) {
    const { theme } = useUnistyles();
    return <>
        {line}
        {limit !== undefined && <Meter ratio={limit.used / 100} emphasis={0.9} marker={limit.elapsed} style={{ marginTop: 8 }} />}
        {quiet.length > 0 && <>
            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.divider, marginTop: 12, marginBottom: 10 }} />
            <FactsLine parts={quiet} />
        </>}
    </>;
}

/**
 * The card's refresh control, always present: a tap asks the host to collect
 * now, past its cache, whether the figures are current, aging, refreshing or
 * failed. The word beside the icon says what the last ask did -- how old the
 * figures are, that a read is running, that it failed, or that the throttle
 * refused this tap -- and is absent while the figures are current, so the
 * control stays quiet chrome rather than a toolbar.
 */
function FreshnessControl({ payload, failed, refreshing, throttledSeconds, onRefresh }: {
    payload?: UsageFigures; failed: boolean; refreshing: boolean; throttledSeconds?: number; onRefresh: () => void;
}) {
    const { theme } = useUnistyles();
    const agedFor = disclosedAge(payload);
    const word = refreshing
        ? t('plugins.rightNow.refreshing')
        : throttledSeconds !== undefined
            ? t('plugins.rightNow.refreshThrottled', { seconds: throttledSeconds })
            : failed
                ? t('plugins.rightNow.refreshFailed')
                : agedFor === undefined ? undefined : t('components.sessionStatusBar.limitAsOf', { age: agedFor });
    // The pill carries the short form -- the countdown, or the sentence up to
    // its reason -- so it fits a section header on a narrow phone; the whole
    // sentence is what a reader hears.
    const shown = !refreshing && throttledSeconds !== undefined
        ? t('plugins.rightNow.refreshIn', { seconds: throttledSeconds })
        : word?.split(' · ')[0];
    const alarm = failed && !refreshing && throttledSeconds === undefined;
    const tint = alarm ? theme.colors.textDestructive : withAlpha(theme.colors.textSecondary, refreshing ? 0.5 : 1);
    return (
        <Pressable onPress={onRefresh} disabled={refreshing} accessibilityRole="button" hitSlop={8}
            accessibilityLabel={word === undefined ? t('plugins.rightNow.refreshNow') : `${word}. ${t('plugins.rightNow.refreshNow')}`}
            // The numbers below never move for this: only the mark and the word
            // change, so a refresh is visible without anything being taken away.
            // A pill like the Usage tabs, so it reads as a control at a glance.
            style={({ pressed }) => ({
                flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1, height: 24,
                paddingLeft: shown === undefined ? 5 : 8, paddingRight: shown === undefined ? 5 : 9, borderRadius: 12,
                borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider,
                backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh,
            })}>
            <Ionicons name="refresh" size={13} color={tint} />
            {shown !== undefined && <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 11.5, lineHeight: 15, ...Typography.mono('regular'), color: tint }}>
                {shown}
            </Text>}
        </Pressable>
    );
}

/** The height of a provider's name line; the mark is locked to it so every
 *  provider shares a baseline. */
const FIGURE_LINE = 18;

/** Below this share remaining a plan is close enough to its ceiling to be worth
 *  reading before the others. Presentation only -- what the windows mean is the
 *  host's to decide; this is only which figure the eye should land on. */
const LOW_REMAINING = 15;

/** Room for the widest share ("100% left"), so every plan's meter ends at the
 *  same x and the shares read down one column. */
const SHARE_COLUMN = 70;

/**
 * One row per connected plan, in the Usage screen's vocabulary: the plan's mark
 * and name with when its tightest window resets, then that window as a neutral
 * meter against 100 with what is left of it. The other windows are one tap
 * away on Usage, and in the row's spoken summary.
 *
 * What this replaces was one line of bare percentages per plan ("0% Monthly
 * 100% 5h 100% 7d"): no name, no reset, and nothing saying which figure
 * answered the question.
 */
function ConnectedStrip({ providers }: { providers: UsageConnectedProvider[] }) {
    return (
        <View style={{ flex: 1, rowGap: 12 }}>
            {providers.map((provider) => <ProviderRow key={provider.id} provider={provider} />)}
        </View>
    );
}

function ProviderRow({ provider }: { provider: UsageConnectedProvider }) {
    const { theme } = useUnistyles();
    const lead = leadWindow(provider.windows);
    if (lead === undefined) return null;
    const left = remainingOf(lead);
    const tone = left === 0 ? 'danger' : left <= LOW_REMAINING ? 'warning' : undefined;
    return (
        <View accessible accessibilityLabel={providerSummary(provider)}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, height: FIGURE_LINE }}>
                <AgentGlyph name={provider.glyph ?? provider.id} size={14} />
                <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.text, fontSize: 13, lineHeight: FIGURE_LINE }}>{provider.label}</Text>
                <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 11.5, ...Typography.mono('regular') }}>{windowTag(lead)}</Text>
                {lead.resetsIn !== undefined && (
                    <Text numberOfLines={1} style={{ marginLeft: 'auto', flexShrink: 1, color: theme.colors.textSecondary, fontSize: 11.5, ...Typography.mono('regular') }}>
                        {t('plugins.rightNow.resetsIn', { time: lead.resetsIn })}
                    </Text>
                )}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 5, marginLeft: 21 }}>
                <Meter ratio={lead.used / 100} emphasis={0.9} marker={lead.elapsed} style={{ flex: 1 }} />
                <Text numberOfLines={1} style={{ minWidth: SHARE_COLUMN, textAlign: 'right', fontSize: 12.5, ...Typography.mono('semiBold'),
                    color: tone === undefined ? theme.colors.text : toneColor(theme, tone) }}>
                    {t('plugins.limits.percentLeft', { percent: left })}
                </Text>
            </View>
        </View>
    );
}

/** The window that runs out first: the one worth leading with. */
function leadWindow(windows: UsageLimitsWindow[]): UsageLimitsWindow | undefined {
    return windows.reduce<UsageLimitsWindow | undefined>(
        (tightest, window) => (tightest === undefined || window.used > tightest.used ? window : tightest),
        undefined,
    );
}

function remainingOf(window: UsageLimitsWindow): number {
    return Math.max(0, 100 - Math.round(window.used));
}

/** The shortest name that still says which window a figure belongs to. */
function windowTag(window: UsageLimitsWindow): string {
    return window.window ?? window.label;
}

/** The strip answers only when the payload itself leads with a real window:
 *  a plan tab's own failure keeps its honest row. */
function hasConnectedStrip(payload: UsageFigures): boolean {
    return (payload.connected?.length ?? 0) > 0 && payload.limits.windows.length > 0;
}

/** One sentence per provider for the reader: "OpenCode Go: 5h 100% left, 7d
 *  32% left". The window names the figures carry on screen are read out too;
 *  a list of bare percentages says as little aloud as it does in print. */
function orderedWindows(provider: UsageConnectedProvider): UsageLimitsWindow[] {
    // Read in the order the row shows them, tightest first: the figure the eye
    // lands on and the one a reader hears should be the same one.
    const lead = leadWindow(provider.windows);
    return lead === undefined ? provider.windows : [lead, ...provider.windows.filter((window) => window !== lead)];
}

function providerSummary(provider: UsageConnectedProvider): string {
    return t('plugins.rightNow.planRemaining', {
        plan: provider.plan ?? provider.label,
        remainings: orderedWindows(provider)
            .map((window) => `${windowTag(window)} ${t('plugins.limits.percentLeft', { percent: remainingOf(window) })}`)
            .join(', '),
    });
}

/** One mono line in the card's quiet voice: a machine at 80% memory is a
 *  machine at work, not a warning, and figures a few minutes old are still
 *  the answer -- so how old they are belongs here, not beside the verdict. */
function FactsLine({ parts, style }: { parts: string[]; style?: object }) {
    const { theme } = useUnistyles();
    // A fact is one unbreakable thing and the separator belongs to the fact
    // before it, so a line can only ever break after a dot. Left to ordinary
    // spaces the line broke inside "load 5.8" and started the next line with a
    // stranded "·".
    const line = parts.map((part) => part.replace(/ /g, '\u00a0')).join('\u00a0· ');
    return (
        <Text style={[{ color: withAlpha(theme.colors.textSecondary, 0.8), fontSize: 11.5, lineHeight: 15, ...Typography.mono('regular') }, style]}>
            {line}
        </Text>
    );
}

/** The quiet line: the machine's own figures, and only those. How old the
 *  limit figures are is not a machine fact, and sharing this line with them
 *  is what wrapped a lone fragment onto a second row; the refresh control
 *  owns it now, since it is the control that acts on it. */
function quietLine(payload: UsageFigures, percent = (value: number) => `${value}%`): string[] {
    return payload.vitals === undefined ? [] : vitalsFigures(payload.vitals, percent);
}

/** The figures the host could read, in order; a filesystem it could not stat
 *  drops its own figure and leaves the rest of the line standing. */
function vitalsFigures(vitals: UsageFigures['vitals'], percent = (value: number) => `${value}%`): string[] {
    const facts = vitals === undefined ? undefined : vitalsFacts(vitals);
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
function disclosedAge(payload: UsageFigures | undefined): string | undefined {
    return payload === undefined || payload.ageSeconds === undefined || payload.ageSeconds < AGE_WORTH_MENTIONING_SECONDS
        ? undefined
        : compactAge(payload.ageSeconds * 1_000);
}

/** With no window to show: the host's own reason when it has one -- an expired
 *  token is not a plan that was never connected -- otherwise the phone's word. */
function emptyLine(payload: UsageFigures): string {
    return payload.limits.message ?? t('plugins.rightNow.notConnected');
}

/** One sentence for the reader; the dots are decorative. How fresh the figures
 *  are, and what to do about it, is the refresh control's own button to announce. */
function cardAccessibilityLabel(payload: UsageFigures): string {
    const parts: string[] = [t('plugins.rightNow.title')];
    if (hasConnectedStrip(payload)) {
        parts.push(payload.connected!.map(providerSummary).join(', '));
    } else if (payload.limits.windows[0] !== undefined) {
        const limit = payload.limits.windows[0];
        const verdict = payload.limits.verdict === 'unknown' ? undefined : t(VERDICT_KEYS[payload.limits.verdict]);
        const line = [verdict, [limit.label, limit.window, t('plugins.limits.percentUsed', { percent: Math.round(limit.used) })].filter(Boolean).join(' ')]
            .filter((part) => part !== undefined).join(', ');
        parts.push(limit.resetsIn === undefined ? line : `${line}, ${t('plugins.rightNow.resetsIn', { time: limit.resetsIn })}`);
    } else {
        parts.push(emptyLine(payload));
    }
    const quiet = quietLine(payload, (percent) => t('plugins.limits.percentUsed', { percent }));
    if (quiet.length > 0) parts.push(quiet.join(', '));
    parts.push(t('plugins.rightNow.opensUsage'));
    return parts.join('. ');
}
