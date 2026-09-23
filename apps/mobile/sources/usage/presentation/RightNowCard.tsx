import * as React from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View, type StyleProp, type ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import type { UsageLimitsWindow } from '@muxr/contract';
import type { UsageFigures } from '../application/freshnessWindow';
import { AgentGlyph } from '@/components/AgentGlyph';
import { cardStyle, Meter, SectionLabel, withAlpha } from '@/components/ui';
import { Typography } from '@/constants/Typography';
import { toneColor } from '@/plugins';
import { VERDICT_KEYS, verdictTone } from '@/plugins/ui';
import { t } from '@/text';
import { compactAge } from '@/utils/compactAge';
import { useUsageNow } from '../application/useUsageNow';
import { columnsPerBand, limitGrid, vitalsFacts, type LimitCell, type LimitColumn, type LimitGrid } from '../domain/usageModel';

/** The card refreshes itself on a slow cadence while someone is looking at it,
 *  so a few minutes behind is normal here and says nothing. Past this the age
 *  is worth a quiet word -- never an alarm. */
const AGE_WORTH_MENTIONING_SECONDS = 600;

/**
 * The top of Home as figures: every connected plan's mark beside what is left
 * of each of its windows, then one quieter vitals line. The section label
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
    // Connected quota windows turn the first row into one strip of plans;
    // Memory/Disk/Load/Uptime stay the quiet row beneath it.
    const grid = connectedGrid(payload);
    const limit = grid !== undefined ? undefined : (payload.cardWindow ?? payload.limits.windows[0]);
    const verdictWord = verdict === 'unknown' ? undefined : t(VERDICT_KEYS[verdict]);
    const tone = verdict === 'unknown' ? undefined : verdictTone(verdict);
    const dot = tone === undefined ? undefined : <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: toneColor(theme, tone) }} />;
    // A refresh that failed says so on the refresh control above, in words and
    // with the action attached. Reddening figures that are still the best
    // known answer would report the wrong thing: they are old, not wrong.
    const line = grid !== undefined
        ? <PlanStrip grid={grid} />
        : limit !== undefined
        ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {dot}
            <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 13, lineHeight: 18 }}>
                {[verdictWord, `${limit.label}${limit.window === undefined ? '' : ` · ${limit.window}`} ${t('plugins.limits.percentLeft', { percent: remainingOf(limit) })}`].filter((part) => part !== undefined).join(' · ')}
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
        {limit !== undefined && <LeftMeter window={limit} style={{ marginTop: 8 }} />}
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

/** Every glyph of the mono face is this share of its size wide, which is what
 *  lets the card know how much room "100%" takes before anything is measured. */
const MONO_ADVANCE = 0.6;
/** The card's margins, padding and border: its content width on a phone until
 *  layout has measured it. */
const CARD_INSET = 2 * (16 + 14 + 1);
/** A plan's figures, in the mono face so every digit is the same width and a
 *  figure that changes never shifts its neighbours. */
const FIGURE_SIZE = 16;
const FIGURE_LINE = 20;
const TAG_SIZE = 10;
const MARK = 18;
const MARK_GAP = 8;
/** The least room between two plans before they read as one. */
const PLAN_GAP = 14;

/**
 * Every connected plan's limits at once, the way a menu bar shows them: a
 * plan's mark, then what is left of each of its windows stacked shortest
 * first, each figure tagged with its window. Plans sit side by side in name
 * order, so each keeps its place as its figures move, and break into balanced
 * rows only when they no longer fit. Figures stay one neutral voice until a
 * limit is actually low.
 *
 * What this replaces was a table: marks as column headers over a row per
 * window length, with an empty cell wherever a plan had no window of that
 * length.
 */
function PlanStrip({ grid }: { grid: LimitGrid }) {
    const { theme } = useUnistyles();
    const screen = useWindowDimensions();
    const [measured, setMeasured] = React.useState<number>();
    const char = MONO_ADVANCE * screen.fontScale;
    const plans = grid.columns.map((column) => ({ column, figures: planFigures(column, grid.rows) }));
    const tagChars = Math.max(2, ...plans.flatMap(({ figures }) => figures.map((figure) => tagText(figure).length)));
    const number = Math.ceil(4 * FIGURE_SIZE * char);
    const unit = MARK + MARK_GAP + number + 3 + tagChars * TAG_SIZE * char;
    const width = measured ?? screen.width - CARD_INSET;
    const perRow = columnsPerBand(plans.length, Math.floor((width + PLAN_GAP) / (unit + PLAN_GAP)));
    return (
        <View onLayout={(event) => setMeasured(event.nativeEvent.layout.width)} style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 14 }}>
            {plans.map(({ column, figures }) => (
                <View key={column.provider.id} style={{ width: `${100 / perRow}%`, flexDirection: 'row', alignItems: 'flex-start', gap: MARK_GAP }}>
                    {/* The mark sits beside the first two figures, short over long,
                        whatever else the plan has: every plan's mark lines up. */}
                    <View style={{ height: 2 * FIGURE_LINE, justifyContent: 'center' }}>
                        <AgentGlyph name={column.provider.glyph ?? column.provider.id} size={MARK} />
                    </View>
                    <View style={{ minHeight: 2 * FIGURE_LINE, justifyContent: 'center' }}>
                        {figures.map((figure) => (
                            <View key={figure.row} style={{ flexDirection: 'row', alignItems: 'baseline' }}>
                                <Text numberOfLines={1} style={{ minWidth: number, textAlign: 'right', fontSize: FIGURE_SIZE, lineHeight: FIGURE_LINE, ...Typography.mono('semiBold'), color: figureColor(theme, figure.cell) }}>{`${figure.cell.left}%`}</Text>
                                <Text numberOfLines={1} style={{ marginLeft: 3, fontSize: TAG_SIZE, ...Typography.mono('regular'), color: theme.colors.textSecondary }}>{tagText(figure)}</Text>
                            </View>
                        ))}
                    </View>
                </View>
            ))}
        </View>
    );
}

interface PlanFigure {
    row: string;
    /** The tightest limit of this length. */
    cell: LimitCell;
    /** How many limits of this length the plan has. */
    count: number;
}

/** A plan's figures in the card's order, shortest window first: one per window
 *  length, the tightest of that length, never a gap for a length it lacks. */
function planFigures(column: LimitColumn, rows: string[]): PlanFigure[] {
    return column.cells.flatMap((cell, index) => (cell.length === 0 ? [] : [{ row: rows[index]!, cell: cell[0]!, count: cell.length }]));
}

/** The window a figure is, as short as it can be said: its published length
 *  ("5h", "7d"), otherwise its name's first letters ("mo" for Monthly), and
 *  "×2" when two limits of that length share the figure. */
function tagText(figure: PlanFigure): string {
    // ponytail: only a billing month publishes no length today; a new unnamed
    // window would read as its first two letters until it gets a real tag.
    const tag = /^\d+[mhd]$/.test(figure.row) ? figure.row : figure.row.slice(0, 2).toLowerCase();
    return figure.count > 1 ? `${tag}×${figure.count}` : tag;
}

function figureColor(theme: ReturnType<typeof useUnistyles>['theme'], cell: LimitCell): string {
    return cell.tone === undefined ? theme.colors.text : toneColor(theme, cell.tone);
}

/** The strip answers when any connected plan has a readable figure. */
function connectedGrid(payload: UsageFigures): LimitGrid | undefined {
    if (payload.connected === undefined) return undefined;
    const grid = limitGrid(payload.connected);
    return grid.columns.length === 0 ? undefined : grid;
}

/** A window's bar drains with what is left, as its figure says; the tick
 *  marks the time left, so a bar short of it is running ahead of pace. */
function LeftMeter({ window, style }: { window: UsageLimitsWindow; style: StyleProp<ViewStyle> }) {
    return <Meter ratio={1 - window.used / 100} emphasis={0.9} marker={window.elapsed === undefined ? undefined : 1 - window.elapsed} style={style} />;
}

function remainingOf(window: UsageLimitsWindow): number {
    return Math.max(0, 100 - Math.round(window.used));
}

/** One sentence per plan, in the order the card shows them: "Claude plan: 5h
 *  100% left, 7d 36% left". A low figure also says why it is coloured and when
 *  it comes back, which the colour alone cannot say aloud. */
function columnSummary(column: LimitColumn, rows: string[]): string {
    const remainings = column.cells.flatMap((limits, index) => limits.map((cell) => {
        const row = rows[index]!;
        const name = limits.length > 1 ? `${cell.window.label} ${row}` : row;
        const figure = `${name} ${t('plugins.limits.percentLeft', { percent: cell.left })}`;
        if (cell.tone === undefined) return figure;
        const why = t(cell.left === 0 ? 'plugins.limits.paceExhausted' : cell.window.pace === 'limited' ? 'plugins.limits.limited' : 'plugins.limits.low');
        const back = cell.window.resetsIn === undefined ? '' : `, ${t('plugins.rightNow.resetsIn', { time: cell.window.resetsIn })}`;
        return `${figure} (${why}${back})`;
    }));
    return t('plugins.rightNow.planRemaining', { plan: column.provider.plan ?? column.provider.label, remainings: remainings.join(', ') });
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
        <Text style={[{ color: withAlpha(theme.colors.textSecondary, 0.7), fontSize: 11, lineHeight: 15, ...Typography.mono('regular') }, style]}>
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
    const grid = connectedGrid(payload);
    if (grid !== undefined) {
        parts.push(...grid.columns.map((column) => columnSummary(column, grid.rows)));
    } else if (payload.limits.windows[0] !== undefined) {
        const limit = payload.limits.windows[0];
        const verdict = payload.limits.verdict === 'unknown' ? undefined : t(VERDICT_KEYS[payload.limits.verdict]);
        const line = [verdict, [limit.label, limit.window, t('plugins.limits.percentLeft', { percent: remainingOf(limit) })].filter(Boolean).join(' ')]
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
