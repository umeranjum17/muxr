import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import type { UsageLimitsWindow } from '@trymuxr/contract';
import type { UsageFigures } from '../application/freshnessWindow';
import { AgentGlyph } from '@/components/AgentGlyph';
import { cardStyle, Meter, ui, withAlpha } from '@/components/ui';
import { Typography } from '@/constants/Typography';
import { toneColor } from '@/plugins';
import { VERDICT_KEYS, verdictTone } from '@/plugins/ui';
import { t } from '@/text';
import { compactAge } from '@/utils/compactAge';
import { useLocalSettingMutable } from '@/catalog/store';
import { useUsageNow } from '../application/useUsageNow';
import { bindingLimit, limitPlans, vitalsFacts, type LimitCell, type LimitPlan } from '../domain/usageModel';

/** The strip refreshes itself on a slow cadence while someone is looking at it,
 *  so a few minutes behind is normal here and says nothing. Past this the age
 *  is worth a quiet word -- never an alarm. */
const AGE_WORTH_MENTIONING_SECONDS = 600;

/** Caption-sized lines; chip figures are a step up, in tabular figures so a
 *  share that changes never shifts its chip. */
const FIGURE_SIZE = 11;
const FIGURE_LINE = 16;
const CHIP_SIZE = 12;
const MARK = 14;
/** The narrowest a chip's bar gets, so even "0%" has a bar to read. */
const CHIP_METER = 32;
/** Room kept clear at the end of the quiet line for the refresh control. */
const CONTROL = 20;

/**
 * The top of Home as one quiet strip above Live: a compact chip per connected
 * plan, wrapping only when the phone is narrow, then one line of the machine's
 * own figures. It is a glance, not a section: no heading and no card, so Live
 * stays the first thing on Home. A tap opens Usage; plan names show until the
 * strip is first used, and a long press brings them back until the next tap.
 * A small refresh control ends the quiet line. The host's typed usage.now
 * method serves it without a plugin.
 */
export function RightNowCard() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [namesHeld, setNamesHeld] = React.useState(false);
    const [namesSeen, setNamesSeen] = useLocalSettingMutable('usageNamesSeen');
    const namesVisible = namesHeld || !namesSeen;
    // The strip paints one of three states and has no fourth: figures it holds,
    // a wait it is in, or a failure with the way back.
    const { display, failed, refreshing, throttledSeconds, refresh } = useUsageNow();
    const open = () => router.push('/usage');
    const caption = { color: theme.colors.textSecondary, fontSize: FIGURE_SIZE, lineHeight: FIGURE_LINE } as const;

    if (display.status === 'unavailable') {
        return <Strip onPress={refresh} label={t('plugins.rightNow.unavailable')}
            line={<View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <View style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: toneColor(theme, 'danger') }} />
                    <Text style={[caption, { flexShrink: 1, color: theme.colors.text }]}>{t('plugins.rightNow.unavailable')}</Text>
                </View>
                {display.reason !== '' && <Text numberOfLines={2} style={caption}>{display.reason}</Text>}
            </View>}
            facts={vitalsFigures(display.vitals)} />;
    }

    const status = freshness(display.status === 'waiting' ? undefined : display.figures, failed, refreshing, throttledSeconds);
    // The control is a sibling of the strip's own press, never inside it: one
    // control nested in another is invalid on the web surface.
    const control = <Pressable onPress={refresh} disabled={refreshing} accessibilityRole="button" hitSlop={12}
        accessibilityLabel={status.word === undefined ? t('plugins.rightNow.refreshNow') : `${status.word}. ${t('plugins.rightNow.refreshNow')}`}
        style={({ pressed }) => ({ position: 'absolute', bottom: 5, right: 8, width: CONTROL, height: CONTROL, borderRadius: CONTROL / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? theme.colors.surfacePressed : undefined })}>
        <Ionicons name="refresh" size={12} color={status.alarm ? theme.colors.textDestructive : withAlpha(theme.colors.textSecondary, refreshing ? 0.4 : 0.8)} />
    </Pressable>;
    // A refresh that failed says so in words at the head of the quiet line;
    // reddening figures that are still the best known answer would report the
    // wrong thing: they are old, not wrong.
    const note = status.shown === undefined ? undefined
        : <Text style={{ color: status.alarm ? theme.colors.textDestructive : undefined }}>{status.shown}</Text>;

    if (display.status === 'waiting') {
        return <View>
            <Strip onPress={open} label={`${t('plugins.rightNow.collecting')}. ${t('plugins.rightNow.opensUsage')}`}
                line={<Text style={caption}>{t('plugins.rightNow.collecting')}</Text>}
                note={note} facts={vitalsFigures(display.vitals)} withControl />
            {control}
        </View>;
    }

    const payload = display.figures;
    const plans = connectedPlans(payload);
    const limit = plans === undefined ? (payload.cardWindow ?? payload.limits.windows[0]) : undefined;
    const verdict = payload.limits.verdict;
    const line = plans !== undefined
        ? <PlanStrip plans={plans} namesVisible={namesVisible} />
        : <Text numberOfLines={2} style={[caption, limit !== undefined && { color: theme.colors.text }]}>
            {limit === undefined ? emptyLine(payload) : [
                verdict === 'unknown' ? undefined : t(VERDICT_KEYS[verdict]),
                `${limit.label}${limit.window === undefined ? '' : ` · ${limit.window}`} ${t('plugins.limits.percentLeft', { percent: remainingOf(limit) })}`,
                limit.resetsIn === undefined ? undefined : t('plugins.rightNow.resetsIn', { time: limit.resetsIn }),
            ].filter((part) => part !== undefined).join(' · ')}
        </Text>;
    return <View>
        <Strip onPress={() => { if (!namesSeen) setNamesSeen(true); if (namesHeld) setNamesHeld(false); else open(); }}
            onLongPress={() => { if (!namesSeen) setNamesSeen(true); setNamesHeld(true); }}
            label={cardAccessibilityLabel(payload)} line={line} note={note} facts={quietLine(payload)}
            dot={limit === undefined || verdict === 'unknown' ? undefined : toneColor(theme, verdictTone(verdict))} withControl />
        {control}
    </View>;
}

/** The strip itself: the plan line, then the machine's quieter one. Content
 *  lines up with the section labels below; the press fills the whole strip so
 *  the tap target stays generous however short the text is. */
function Strip({ onPress, onLongPress, label, line, note, facts, dot, withControl = false }: {
    onPress: () => void; onLongPress?: () => void; label: string; line: React.ReactNode; note?: React.ReactNode; facts: string[]; dot?: string; withControl?: boolean;
}) {
    const { theme } = useUnistyles();
    return (
        <Pressable onPress={onPress} onLongPress={onLongPress} accessibilityRole="button" accessibilityLabel={label}
            style={({ pressed }) => ({
                marginTop: 12, marginHorizontal: 8, paddingHorizontal: 8, paddingVertical: 7, minHeight: 44, borderRadius: 12,
                justifyContent: 'center', gap: 2, backgroundColor: pressed ? theme.colors.surfacePressed : undefined,
            })}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {dot !== undefined && <View style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: dot }} />}
                <View style={{ flex: 1 }}>{line}</View>
            </View>
            {/* The refresh control sits over this line's end, so the line stays
                even when it is empty. */}
            {(withControl || note !== undefined || facts.length > 0) && <View style={{ paddingRight: withControl ? CONTROL + 4 : 0, minHeight: withControl ? 15 : undefined }}>
                <FactsLine note={note} parts={facts} />
            </View>}
        </Pressable>
    );
}

/** What the refresh control has to say: how old the figures are, that a read
 *  is running, that it failed, or that the throttle refused the last tap --
 *  nothing while the figures are current. `shown` is the short form for the
 *  strip; `word` is the whole sentence a reader hears. */
function freshness(payload: UsageFigures | undefined, failed: boolean, refreshing: boolean, throttledSeconds?: number) {
    const agedFor = disclosedAge(payload);
    const word = refreshing
        ? t('plugins.rightNow.refreshing')
        : throttledSeconds !== undefined
            ? t('plugins.rightNow.refreshThrottled', { seconds: throttledSeconds })
            : failed
                ? t('plugins.rightNow.refreshFailed')
                : agedFor === undefined ? undefined : t('components.sessionStatusBar.limitAsOf', { age: agedFor });
    const shown = !refreshing && throttledSeconds !== undefined
        ? t('plugins.rightNow.refreshIn', { seconds: throttledSeconds })
        : word?.split(' · ')[0];
    return { word, shown, alarm: failed && !refreshing && throttledSeconds === undefined };
}

/**
 * Every connected plan as one compact chip: its mark, then the share left of
 * the window that will block it first, over a bar of the same share. Chips sit
 * side by side in name order and wrap rather than cut anything short. A plan's
 * name and that window's tag show on first use and on a long press; the
 * spoken summary always names every limit.
 */
function PlanStrip({ plans, namesVisible }: { plans: LimitPlan[]; namesVisible: boolean }) {
    const { theme } = useUnistyles();
    return (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {plans.map((plan) => {
                const { name, cell } = bindingLimit(plan);
                return (
                    <View key={plan.provider.id} style={[cardStyle(theme), { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%', borderRadius: ui.radius.control, paddingHorizontal: 8, paddingVertical: 6 }]}>
                        <AgentGlyph name={plan.provider.glyph ?? plan.provider.id} size={MARK} />
                        <View style={{ flexShrink: 1, minWidth: CHIP_METER, gap: 4 }}>
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 4 }}>
                                {namesVisible && <Text style={{ fontSize: CHIP_SIZE, lineHeight: FIGURE_LINE, color: theme.colors.text, ...Typography.default('semiBold') }}>{plan.provider.label}</Text>}
                                <Text style={{ fontSize: CHIP_SIZE, lineHeight: FIGURE_LINE, fontVariant: ['tabular-nums'], ...Typography.default('semiBold'), color: figureColor(theme, cell) }}>{`${cell.left}%`}</Text>
                                {namesVisible && <Text style={{ fontSize: CHIP_SIZE, lineHeight: FIGURE_LINE, color: theme.colors.textSecondary, ...Typography.default() }}>{name}</Text>}
                            </View>
                            <Meter ratio={cell.left / 100} />
                        </View>
                    </View>
                );
            })}
        </View>
    );
}

function figureColor(theme: ReturnType<typeof useUnistyles>['theme'], cell: LimitCell): string {
    return cell.tone === undefined ? theme.colors.text : toneColor(theme, cell.tone);
}

/** The strip answers when any connected plan has a readable figure. */
function connectedPlans(payload: UsageFigures): LimitPlan[] | undefined {
    const plans = limitPlans(payload.connected ?? []);
    return plans.length === 0 ? undefined : plans;
}

function remainingOf(window: UsageLimitsWindow): number {
    return Math.max(0, 100 - Math.round(window.used));
}

/** One sentence per plan, in the order the card shows them: "Claude plan: 5h
 *  100% left, 7d 36% left". A low figure also says why it is coloured and when
 *  it comes back, which the colour alone cannot say aloud. */
function planSummary(plan: LimitPlan): string {
    const remainings = plan.figures.flatMap(({ name, cells }) => cells.map((cell) => {
        const title = cells.length > 1 ? `${cell.window.label} ${name}` : name;
        const figure = `${title} ${t('plugins.limits.percentLeft', { percent: cell.left })}`;
        if (cell.tone === undefined) return figure;
        const why = t(cell.left === 0 ? 'plugins.limits.paceExhausted' : cell.window.pace === 'limited' ? 'plugins.limits.limited' : 'plugins.limits.low');
        const back = cell.window.resetsIn === undefined ? '' : `, ${t('plugins.rightNow.resetsIn', { time: cell.window.resetsIn })}`;
        return `${figure} (${why}${back})`;
    }));
    return t('plugins.rightNow.planRemaining', { plan: plan.provider.plan ?? plan.provider.label, remainings: remainings.join(', ') });
}

/** The quiet line, in caption size: a machine at 80% memory is a machine at
 *  work, not a warning. A refresh note, when there is one, leads it. */
function FactsLine({ note, parts }: { note?: React.ReactNode; parts: string[] }) {
    const { theme } = useUnistyles();
    // A fact is one unbreakable thing and the separator belongs to the fact
    // before it, so a line can only ever break after a dot. Left to ordinary
    // spaces the line broke inside "load 5.8" and started the next line with a
    // stranded "·".
    const line = parts.map((part) => part.replace(/ /g, '\u00a0')).join('\u00a0· ');
    return (
        <Text style={{ color: withAlpha(theme.colors.textSecondary, 0.75), fontSize: 11, lineHeight: 15 }}>
            {note}
            {note !== undefined && line !== '' && '\u00a0· '}
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
    const plans = connectedPlans(payload);
    if (plans !== undefined) {
        parts.push(...plans.map(planSummary));
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
