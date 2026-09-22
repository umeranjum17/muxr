import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
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

/** The card refreshes itself on a slow cadence while someone is looking at it,
 *  so a few minutes behind is normal here and says nothing. Past this the age
 *  is worth a quiet word -- never an alarm. */
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
    const { value: payload, failed, refreshing, throttledSeconds, refresh } = useUsageNow();

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
            <Pressable onPress={refresh} accessibilityRole="button" accessibilityLabel={t('plugins.rightNow.unavailable')}
                style={[cardStyle(theme), { marginHorizontal: 16, padding: 14 }]}>
                {line}
            </Pressable>
        </View>;
    }

    if (payload === undefined) return null;
    const verdict = payload.limits.verdict;
    // A collection that never finished is a failure, not a state to sit in: it
    // says so and its press asks again, rather than opening a screen that has
    // no more to show than this card does.
    const stalled = failed && payload.collecting === true;
    // Real quota windows for more than the selected tab turn the first row
    // into one restrained provider strip; Memory/Disk/Load/Uptime stay the
    // quiet row beneath it. A plan tab's own failure message keeps its row.
    const strip = hasConnectedStrip(payload);
    const limit = strip ? undefined : payload.limits.windows[0];
    const verdictWord = verdict === 'unknown' ? undefined : t(VERDICT_KEYS[verdict]);
    const tone = verdict === 'unknown' ? undefined : verdictTone(verdict);
    const dot = tone === undefined ? undefined : <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: toneColor(theme, tone) }} />;
    // A refresh that failed says so in the freshness row below, in words and
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
                {[verdictWord, `${limit.label} ${Math.round(limit.used)}%`].filter((part) => part !== undefined).join(' · ')}
            </Text>
            {limit.resetsIn !== undefined && <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18 }}>{` · ${t('plugins.rightNow.resetsIn', { time: limit.resetsIn })}`}</Text>}
            <View style={{ marginLeft: 'auto' }}>
                <Ionicons name="chevron-forward" size={14} color={withAlpha(theme.colors.textSecondary, 0.6)} />
            </View>
        </View>
        : <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ flexShrink: 1, color: stalled ? theme.colors.textDestructive : theme.colors.textSecondary, fontSize: 13, lineHeight: 18 }}>
                {collectingLine(payload, stalled)}
            </Text>
        </View>;
    // The freshness control is a sibling of the card's own press, never inside
    // it: one control nested in another is invalid on the web surface, and on
    // any surface it makes a small target that opens a screen overlap a
    // smaller one that does not.
    return <View>
        {label}
        <View style={[cardStyle(theme), { marginHorizontal: 16, padding: 14 }]}>
            <Pressable onPress={stalled ? refresh : open} accessibilityRole="button" accessibilityLabel={cardAccessibilityLabel(payload, failed)}>
                <CardBody limit={limit} line={line} quiet={quietLine(payload)} />
            </Pressable>
            <FreshnessRow payload={payload} failed={failed} refreshing={refreshing} throttledSeconds={throttledSeconds} onRefresh={refresh} />
        </View>
    </View>;
}

function CardBody({ limit, line, quiet }: { limit?: UsageLimitsWindow; line: React.ReactNode; quiet: string[] }) {
    return <>
        {line}
        {limit !== undefined && <Meter ratio={limit.used / 100} emphasis={0.9} marker={limit.elapsed} style={{ marginTop: 8, marginBottom: 10 }} />}
        {quiet.length > 0 && <FactsLine parts={quiet} style={limit === undefined ? { marginTop: 10 } : undefined} />}
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
function FreshnessRow({ payload, failed, refreshing, throttledSeconds, onRefresh }: {
    payload: UsageNow; failed: boolean; refreshing: boolean; throttledSeconds?: number; onRefresh: () => void;
}) {
    const { theme } = useUnistyles();
    const agedFor = disclosedAge(payload);
    const word = refreshing
        ? t('plugins.rightNow.refreshing')
        : failed
            ? t('plugins.rightNow.refreshFailed')
            : throttledSeconds !== undefined
                ? t('plugins.rightNow.refreshThrottled', { seconds: throttledSeconds })
                : agedFor === undefined ? undefined : t('components.sessionStatusBar.limitAsOf', { age: agedFor });
    const alarm = failed && !refreshing;
    const tint = alarm ? theme.colors.textDestructive : withAlpha(theme.colors.textSecondary, refreshing ? 0.5 : 1);
    return (
        <Pressable onPress={onRefresh} disabled={refreshing} accessibilityRole="button"
            accessibilityLabel={word === undefined ? t('plugins.rightNow.refreshNow') : `${word}. ${t('plugins.rightNow.refreshNow')}`}
            // The numbers above never move for this: only the mark and the word
            // change, so a refresh is visible without anything being taken away.
            style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 8, paddingVertical: 4 }}>
            <Ionicons name="refresh" size={12} color={tint} />
            {word !== undefined && <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 11.5, lineHeight: 15, ...Typography.mono('regular'), color: tint }}>
                {word}
            </Text>}
        </Pressable>
    );
}

/** The height of one figure line; the mark is locked to it so every provider
 *  shares a baseline however many windows it publishes. */
const FIGURE_LINE = 15;

/** One line per connected provider: its mark, then every quota window as a
 *  named figure. One line each is what makes the entries comparable -- the
 *  stacked columns this replaces gave each provider a different height and a
 *  different centre, and printed bare percentages that named no window.
 *  Providers publish different numbers of windows, so the rows end at
 *  different widths; they never start at different heights. */
function ConnectedStrip({ providers }: { providers: UsageConnectedProvider[] }) {
    return (
        <View style={{ flexShrink: 1, rowGap: 3 }}>
            {providers.map((provider) => (
                <View key={provider.id} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}
                    accessibilityLabel={providerSummary(provider)}>
                    <View style={{ height: FIGURE_LINE, justifyContent: 'center' }}>
                        <AgentGlyph name={provider.glyph ?? provider.id} size={14} />
                    </View>
                    <View style={{ flexShrink: 1, flexDirection: 'row', flexWrap: 'wrap', columnGap: 8, rowGap: 1 }}>
                        {provider.windows.map((window, index) => <WindowFigure key={index} window={window} />)}
                    </View>
                </View>
            ))}
        </View>
    );
}

/** One window as a figure that says what it is: the published length when the
 *  host knows one ("5h", "7d"), otherwise the window's own name ("Monthly").
 *  A window with nothing left is the one fact worth colouring. */
function WindowFigure({ window }: { window: UsageLimitsWindow }) {
    const { theme } = useUnistyles();
    const left = Math.max(0, 100 - Math.round(window.used));
    return (
        <Text numberOfLines={1} style={{ fontSize: 11.5, lineHeight: FIGURE_LINE, ...Typography.mono('regular') }}>
            <Text style={{ color: theme.colors.textSecondary }}>{`${windowTag(window)}\u00a0`}</Text>
            <Text style={{ color: left === 0 ? theme.colors.textDestructive : theme.colors.text }}>{`${left}%`}</Text>
        </Text>
    );
}

/** The shortest name that still says which window a figure belongs to. */
function windowTag(window: UsageLimitsWindow): string {
    return window.window ?? window.label;
}

/** The strip answers only when the payload itself leads with a real window:
 *  a plan tab's own failure keeps its honest row. */
function hasConnectedStrip(payload: UsageNow): boolean {
    return (payload.connected?.length ?? 0) > 0 && payload.limits.windows.length > 0;
}

/** One sentence per provider for the reader: "OpenCode Go: 5h 100% left, 7d
 *  32% left". The window names the figures carry on screen are read out too;
 *  a list of bare percentages says as little aloud as it does in print. */
function providerSummary(provider: UsageConnectedProvider): string {
    return t('plugins.rightNow.planRemaining', {
        plan: provider.plan ?? provider.label,
        remainings: provider.windows
            .map((window) => `${windowTag(window)} ${t('plugins.limits.percentLeft', { percent: Math.max(0, 100 - Math.round(window.used)) })}`)
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
        <Text style={[{ color: theme.colors.textSecondary, fontSize: 11.5, lineHeight: 15, ...Typography.mono('regular') }, style]}>
            {line}
        </Text>
    );
}

/** The quiet line: the machine's own figures, and only those. How old the
 *  limit figures are is not a machine fact, and sharing this line with them
 *  is what wrapped a lone fragment onto a second row; the freshness row owns
 *  it now, where the control that acts on it lives. */
function quietLine(payload: UsageNow, percent = (value: number) => `${value}%`): string[] {
    return payload.vitals === undefined ? [] : vitalsFigures(payload.vitals, percent);
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

/** The host answers `collecting` while its usage cache is cold and keeps
 *  collecting behind the reply, so the word is honest only while the card is
 *  still asking. Once the follow-ups have run out it is a failure to collect,
 *  and the card stops claiming otherwise. */
function collectingLine(payload: UsageNow, stalled: boolean): string {
    if (payload.collecting !== true) return emptyLine(payload);
    return stalled ? t('plugins.rightNow.unavailable') : t('plugins.rightNow.collecting');
}

/** With no window to show: the host's own reason when it has one -- an expired
 *  token is not a plan that was never connected -- otherwise the phone's word. */
function emptyLine(payload: UsageNow): string {
    return payload.limits.message ?? t('plugins.rightNow.notConnected');
}

/** One sentence for the reader; the dots are decorative. How fresh the figures
 *  are, and what to do about it, is the freshness row's own button to announce. */
function cardAccessibilityLabel(payload: UsageNow, stale: boolean): string {
    const stalled = stale && payload.collecting === true;
    const parts: string[] = [t('plugins.rightNow.title')];
    if (hasConnectedStrip(payload)) {
        parts.push(payload.connected!.map(providerSummary).join(', '));
    } else if (payload.limits.windows[0] !== undefined) {
        const limit = payload.limits.windows[0];
        const verdict = payload.limits.verdict === 'unknown' ? undefined : t(VERDICT_KEYS[payload.limits.verdict]);
        const line = [verdict, [limit.label, t('plugins.limits.percentUsed', { percent: Math.round(limit.used) })].join(' ')]
            .filter((part) => part !== undefined).join(', ');
        parts.push(limit.resetsIn === undefined ? line : `${line}, ${t('plugins.rightNow.resetsIn', { time: limit.resetsIn })}`);
    } else {
        parts.push(collectingLine(payload, stalled));
    }
    const quiet = quietLine(payload, (percent) => t('plugins.limits.percentUsed', { percent }));
    if (quiet.length > 0) parts.push(quiet.join(', '));
    // The failed card retries where a working one opens Usage, so it must not
    // promise the screen it is not going to open.
    if (!stalled) parts.push(t('plugins.rightNow.opensUsage'));
    return parts.join('. ');
}
