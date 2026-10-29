import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import type { UsageLimitsWindow } from '@trymuxr/contract';
import type { UsageFigures } from '../application/freshnessWindow';
import { AgentGlyph } from '@/components/AgentGlyph';
import { withAlpha } from '@/components/ui';
import { Typography } from '@/constants/Typography';
import { toneColor } from '../domain/usageTone';
import { VERDICT_KEYS, verdictTone } from './ScreenLimits';
import { t } from '@/text';
import { compactAge } from '@/utils/compactAge';
import { useUsageNow } from '../application/useUsageNow';
import { limitPlans, type LimitCell, type LimitFigure, type LimitPlan } from '../domain/usageModel';

/** The strip refreshes itself on a slow cadence while someone is looking at it,
 *  so a few minutes behind is normal here and says nothing. Past this the age
 *  is worth a quiet word -- never an alarm. */
const AGE_WORTH_MENTIONING_SECONDS = 600;

/** Plan figures: caption-sized, in the mono face so a figure that changes
 *  never shifts its neighbours. Window tags are smaller still. */
const FIGURE_SIZE = 11;
const FIGURE_LINE = 16;
const TAG_SIZE = 8.5;
const MARK = 12;
/** Room kept clear at the end of the quiet line for the refresh control. */
const CONTROL = 20;

/**
 * The top of Home as one quiet strip above Live: each connected plan's mark
 * beside its limits in caption-sized figures, wrapping only when the phone is
 * narrow, then one line saying what the herd is doing. It is a glance, not a
 * section: no heading and no card, so Live stays the first thing on Home. A
 * tap opens Usage, a long press reveals full limit names until the next tap,
 * and a small refresh control ends the quiet line. The host's typed usage.now
 * method serves it without a plugin.
 */
export function RightNowCard({ linkDown = false, agentLine }: { linkDown?: boolean; agentLine?: string }) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [namesVisible, setNamesVisible] = React.useState(false);
    // The strip paints one of three states and has no fourth: figures it holds,
    // a wait it is in, or a failure with the way back.
    const { display, failed, refreshing, throttledSeconds, refresh } = useUsageNow();
    // What the herd is doing, in plain words, from Home: the machine's own load
    // used to stand here as one word ("Busy"), which read as the agent's state
    // and told nobody whether anything was waiting on them. The machine's
    // figures stay a tap on the computer's name (see hostVitalsDetails).
    const facts = agentLine === undefined ? [] : [agentLine];
    const open = () => router.push('/usage');
    const caption = { color: theme.colors.textSecondary, fontSize: FIGURE_SIZE, lineHeight: FIGURE_LINE } as const;
    // A failure read while the link was down is about the link, not usage:
    // ask again the moment it is back rather than at the next backed-off retry.
    const wasDown = React.useRef(linkDown);
    React.useEffect(() => {
        if (wasDown.current && !linkDown && display.status === 'unavailable') refresh();
        wasDown.current = linkDown;
    }, [display.status, linkDown, refresh]);
    // Home's connection state already says the computer is out of reach; the
    // strip keeps only figures it holds and never repeats that as a failure.
    if (linkDown && display.status !== 'figures') return null;

    // Usage the host could not read is information, not an alarm: a quiet
    // mark, and a tap still asks again.
    if (display.status === 'unavailable') {
        return <Strip onPress={refresh} label={t('plugins.rightNow.unavailable')}
            line={<View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <View style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: withAlpha(theme.colors.textSecondary, 0.6) }} />
                    <Text style={[caption, { flexShrink: 1, color: theme.colors.text }]}>{t('plugins.rightNow.unavailable')}</Text>
                </View>
                {display.reason !== '' && <Text numberOfLines={2} style={caption}>{display.reason}</Text>}
            </View>}
            facts={facts} />;
    }

    const status = freshness(display.status === 'waiting' ? undefined : display.figures, failed && !linkDown, refreshing, throttledSeconds);
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
                note={note} facts={facts} withControl />
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
        <Strip onPress={() => { if (namesVisible) setNamesVisible(false); else open(); }} onLongPress={() => setNamesVisible(true)}
            label={cardAccessibilityLabel(payload, facts)} line={line} note={note} facts={facts}
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
    const failedAge = payload?.ageSeconds === undefined ? 'Last update time unknown.'
        : t('components.sessionStatusBar.limitAsOf', { age: compactAge((payload.ageSeconds * 1_000) + Math.max(0, Date.now() - (payload.ageAt ?? Date.now()))) });
    let word: string | undefined;
    if (failed) word = `${t('plugins.rightNow.refreshFailed')} · ${failedAge}`;
    else if (refreshing) word = t('plugins.rightNow.refreshing');
    else if (throttledSeconds !== undefined) word = t('plugins.rightNow.refreshThrottled', { seconds: throttledSeconds });
    else if (agedFor !== undefined) word = t('components.sessionStatusBar.limitAsOf', { age: agedFor });
    let shown = failed ? word : word?.split(' · ')[0];
    if (!failed && !refreshing && throttledSeconds !== undefined) shown = t('plugins.rightNow.refreshIn', { seconds: throttledSeconds });
    return { word, shown, alarm: failed && !refreshing && throttledSeconds === undefined };
}

/**
 * Every connected plan's limits in one line, the way a menu bar shows them: a
 * plan's small mark, then the tightest share left for each window length or
 * name with its tag, shortest first, with a count for grouped limits. Plans sit
 * side by side in name order and wrap only when the line runs out. Figures stay
 * neutral until a limit is low; the spoken summary names every limit.
 */
function PlanStrip({ plans, namesVisible }: { plans: LimitPlan[]; namesVisible: boolean }) {
    const { theme } = useUnistyles();
    return (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 8, rowGap: 1 }}>
            {plans.map((plan) => {
                const tags = figureTags(plan.figures);
                return (
                    <View key={plan.provider.id} style={{ flexDirection: namesVisible ? 'column' : 'row', flexWrap: 'wrap', maxWidth: '100%', alignItems: namesVisible ? 'flex-start' : 'center', gap: namesVisible ? 0 : 4, width: namesVisible ? '100%' : undefined }}>
                        <AgentGlyph name={plan.provider.glyph ?? plan.provider.id} size={MARK} />
                        {plan.figures.map((figure, index) => (
                            <View key={figure.name} style={{ flexDirection: 'row', alignItems: 'baseline', maxWidth: '100%' }}>
                                <Text style={{ marginRight: 4, flexShrink: namesVisible ? 1 : 0, fontSize: TAG_SIZE, ...Typography.mono('regular'), color: theme.colors.textSecondary }}>{`${namesVisible ? figure.name : tags[index]}${figure.cells.length > 1 ? `×${figure.cells.length}` : ''}`}</Text>
                                <Text style={{ flexShrink: 0, fontSize: FIGURE_SIZE, lineHeight: FIGURE_LINE, ...Typography.mono('regular'), color: figureColor(theme, figure.cells[0]!) }}>{t('plugins.limits.percentLeft', { percent: figure.cells[0]!.left })}</Text>
                            </View>
                        ))}
                    </View>
                );
            })}
        </View>
    );
}

function figureTags(figures: LimitFigure[]): string[] {
    const names = figures.map(({ name }) => name.replace(/\s*·\s*Limit$/i, '').replace(/^(Month|Week)ly$/i, '$1'));
    const bound = (name: string) => name.length <= 6 ? name : `${name.slice(0, 5)}…`;
    const base = names.map(bound);
    const tags = base.map((tag, index) => {
        const colliding = names.filter((_, other) => base[other] === tag);
        if (colliding.length === 1) return tag;
        let prefix = colliding[0]!;
        for (const name of colliding) while (!name.startsWith(prefix)) prefix = prefix.slice(0, -1);
        return bound(names[index]!.slice(prefix.length).replace(/^[\s·._-]+/, '') || names[index]!);
    });
    const used = new Set<string>();
    for (const { index } of figures.map(({ name }, index) => ({ name, index })).sort((a, b) => a.name.localeCompare(b.name))) {
        let tag = tags[index]!;
        if (tags.filter((value) => value === tag).length > 1 || used.has(tag)) {
            let suffix = 1;
            do {
                const ending = `…${suffix++}`;
                tag = `${names[index]!.slice(0, Math.max(0, 6 - ending.length))}${ending}`;
            } while (used.has(tag) || tags.includes(tag));
            tags[index] = tag;
        }
        used.add(tag);
    }
    return tags;
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

/** The quiet line, in caption size: what the herd is doing, said in one plain
 *  sentence, with the note about a failed refresh ahead of it when there is one.
 *  It wraps like any other text: a sentence is not a figure, and gluing its
 *  words together left no break point in a narrow phone. */
function FactsLine({ note, parts }: { note?: React.ReactNode; parts: string[] }) {
    const { theme } = useUnistyles();
    const line = parts.join(' · ');
    return (
        <Text style={{ color: withAlpha(theme.colors.textSecondary, 0.75), fontSize: 11, lineHeight: 15 }}>
            {note}
            {note !== undefined && line !== '' && ' · '}
            {line}
        </Text>
    );
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
function cardAccessibilityLabel(payload: UsageFigures, facts: readonly string[]): string {
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
    if (facts.length > 0) parts.push(facts.join(', '));
    parts.push(t('plugins.rightNow.opensUsage'));
    return parts.join('. ');
}
