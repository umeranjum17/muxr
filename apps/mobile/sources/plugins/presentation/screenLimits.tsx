import { StyleSheet, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { PluginScreenLimitsNode, PluginScreenTone } from '@muxr/contract';
import { asLimitsPayload, type PluginLimitsPayload, type PluginLimitsWindow } from '../domain/limitsModel';
import { resolvePath, bindText } from '../domain/screenModel';
import { resolvePluginText } from '../domain/pluginText';
import { toneColor } from '../domain/pluginTone';
import { cardStyle, SectionLabel, Meter } from '@/components/ui';
import { Typography } from '@/constants/Typography';
import { compactAge } from '@/utils/compactAge';
import { t } from '@/text';

/** One verdict vocabulary for every limit surface; the Right now card reads
 *  the same five words and the same five colours. */
export const verdictTone = (verdict: PluginLimitsPayload['verdict']): PluginScreenTone =>
    verdict === 'go' ? 'positive'
        : verdict === 'unknown' ? 'secondary'
            : verdict === 'watch' || verdict === 'ahead' ? 'warning'
                : 'danger';

/** Below this share of the window gone, a projection is noise, not a trend:
 *  a window that just opened says nothing about how it will end. */
const MIN_ELAPSED_FOR_PROJECTION = 0.01;
/** A window that will not outlast its reset reads as urgent only when the
 *  moment it runs out is close; earlier it is a plan, not an emergency. */
const RUNS_OUT_SOON_MS = 60 * 60_000;

/** Seconds in the host's reset spelling ("16d 23h", "4h 11m", "45m"). */
function resetSeconds(resetsIn: string | undefined): number | undefined {
    if (resetsIn === undefined) return undefined;
    let seconds = 0;
    for (const [, amount, unit] of resetsIn.matchAll(/(\d+)\s*([dhm])/g)) {
        seconds += Number(amount) * { d: 86_400, h: 3_600, m: 60 }[unit as 'd' | 'h' | 'm']!;
    }
    return seconds > 0 ? seconds : undefined;
}

/** What one window's own pace says is coming, computed from the figures the
 *  host already publishes: at the pace so far, does it outlast the reset?
 *  Calm while it does (undefined -- the host's word stands); warm once it
 *  will not, with the moment named; strong only when that moment is soon.
 *  A window already out keeps the host's own verdict. */
export function runOut(window: PluginLimitsWindow): { tone: 'warning' | 'danger'; note: string } | undefined {
    const elapsed = window.elapsed;
    if (elapsed === undefined || elapsed < MIN_ELAPSED_FOR_PROJECTION) return undefined;
    if (window.used <= 0 || window.used >= 100 || window.pace === 'limited') return undefined;
    if (window.used / elapsed <= 100) return undefined;
    const reset = resetSeconds(window.resetsIn);
    if (reset === undefined) return undefined;
    // At the pace so far the remaining share takes the same fraction of the
    // elapsed wall time as the share is of what was used when it was spent.
    const ms = ((100 - window.used) / window.used) * (elapsed / (1 - elapsed)) * reset * 1_000;
    return {
        tone: ms <= RUNS_OUT_SOON_MS ? 'danger' : 'warning',
        note: t('plugins.limits.runsOutIn', { time: compactAge(Math.max(ms, 60_000)) }),
    };
}

const PACE_KEYS: Record<NonNullable<PluginLimitsWindow['pace']>, Parameters<typeof t>[0]> = {
    limited: 'plugins.limits.limited',
    low: 'plugins.limits.low',
    watch: 'plugins.limits.watch',
    ahead: 'plugins.limits.ahead',
    'on pace': 'plugins.limits.paceOnTrack',
};

export const VERDICT_KEYS: Record<Exclude<PluginLimitsPayload['verdict'], 'unknown'>, Parameters<typeof t>[0]> = {
    limited: 'plugins.limits.limited',
    low: 'plugins.limits.low',
    watch: 'plugins.limits.watch',
    ahead: 'plugins.limits.ahead',
    go: 'plugins.limits.go',
};

/** The verdict this payload may show, after its own windows' projections:
 *  a window that runs out before its reset forbids the calm green "Go
 *  ahead", so the presentation steps the host verdict up to the same three
 *  levels the figures use. A host verdict already at or past that severity
 *  stands. */
export function presentedVerdict(payload: PluginLimitsPayload): PluginLimitsPayload['verdict'] {
    if (payload.verdict === 'unknown') return 'unknown';
    let worst: 'warning' | 'danger' | undefined;
    for (const window of payload.windows) {
        const run = runOut(window);
        if (run === undefined) continue;
        if (run.tone === 'danger') { worst = 'danger'; break; }
        worst = 'warning';
    }
    if (worst === undefined) return payload.verdict;
    const SEVERITY: Record<string, number> = { primary: 0, secondary: 0, positive: 0, warning: 1, danger: 2 };
    if (SEVERITY[verdictTone(payload.verdict)] >= SEVERITY[worst]) return payload.verdict;
    return worst === 'danger' ? 'low' : 'watch';
}

/** The tightest window leads the card: highest share used; on ties, the first
 *  published window wins (the host keeps provider order, so ties fall to the
 *  window the provider named first). */
function bindingWindow(windows: PluginLimitsWindow[]): PluginLimitsWindow | undefined {
    return windows.reduce<PluginLimitsWindow | undefined>((worst, window) =>
        worst === undefined || window.used > worst.used ? window : worst, undefined);
}

function limitsSummary(payload: PluginLimitsPayload): string {
    const verdict = presentedVerdict(payload);
    const tightest = bindingWindow(payload.windows);
    const head = [verdict === 'unknown' ? undefined : t(VERDICT_KEYS[verdict]), tightest === undefined ? undefined : t('plugins.limits.percentLeft', { percent: 100 - Math.round(tightest.used) })]
        .filter((part) => part !== undefined).join(', ');
    const rows = payload.windows.map((window) => {
        const parts = [[window.label, window.window, t('plugins.limits.percentLeft', { percent: 100 - Math.round(window.used) })].filter(Boolean).join(' ')];
        if (window.resetsIn !== undefined) parts.push(t('plugins.rightNow.resetsIn', { time: window.resetsIn }));
        const run = runOut(window);
        if (run !== undefined) parts.push(run.note);
        else if (window.pace != null) parts.push(t(PACE_KEYS[window.pace]));
        return parts.join(', ');
    });
    return [`${payload.plan ?? t('plugins.rightNow.title')}: ${head}`, ...rows].join('. ');
}

/**
 * "Can I start a task right now, and when do I get more": one verdict word,
 * one headroom headline, then every window as evidence against the same 100
 * ceiling. The host normalizes each provider into the payload; this renderer
 * never learns a provider's name. `asOf` pins retained figures to the moment
 * they were true, on the card they describe.
 */
export function ScreenLimits({ node, data, asOf }: { node: PluginScreenLimitsNode; data: unknown; asOf?: string }) {
    const { theme } = useUnistyles();
    const payload = asLimitsPayload(resolvePath(data, node.path));
    const title = node.title === undefined ? undefined : bindText(resolvePluginText(node.title), data);
    // Nothing to answer with: the section label plus the host's quiet line,
    // following the chart empty-state precedent (no card).
    if (payload.verdict === 'unknown' && payload.windows.length === 0) {
        const message = payload.message ?? '';
        const empty = node.emptyText === undefined ? '' : bindText(resolvePluginText(node.emptyText), data);
        const line = message !== '' ? message : empty;
        // An absent provider is represented by the screen's empty node; do not
        // leave a lone "Right now" heading behind when there is no limit copy.
        if (line === '') return null;
        return (
            <View style={{ marginBottom: 14 }}>
                {title !== undefined && <SectionLabel>{title}</SectionLabel>}
                {line !== '' && <Text style={{ color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 6 }}>{line}</Text>}
            </View>
        );
    }
    const tightest = bindingWindow(payload.windows);
    // Verdict word, dot and headline all speak the presentation verdict, so
    // none of them can read calm while a figure below is warm or strong.
    const presented = presentedVerdict(payload);
    const verdictWord = presented === 'unknown' ? undefined : t(VERDICT_KEYS[presented]);
    const tone = verdictTone(presented);
    const headlineTone: PluginScreenTone = presented === 'go' ? 'secondary' : tone;
    return (
        <View style={{ marginBottom: 14 }}>
            {/* The section's own label row, like every other section: the card
                below starts with the answer, not with its caption. */}
            {(title !== undefined || payload.plan !== undefined) && (
                <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
                    {title !== undefined ? <SectionLabel>{title}</SectionLabel> : <View />}
                    {payload.plan !== undefined && (
                        <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.textSecondary, fontSize: 11.5, lineHeight: 16, ...Typography.mono('regular') }}>{payload.plan}</Text>
                    )}
                </View>
            )}
            <View
                accessible
                accessibilityRole="summary"
                accessibilityLabel={[limitsSummary(payload), asOf].filter(Boolean).join('. ')}
                style={[cardStyle(theme), { padding: 16, paddingTop: 14 }]}
            >
                {verdictWord !== undefined && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: toneColor(theme, tone) }} />
                        <Text style={{ color: theme.colors.text, fontSize: 17, lineHeight: 22, fontWeight: '600', flex: 1, ...Typography.default('semiBold') }}>{verdictWord}</Text>
                    </View>
                )}
                {tightest !== undefined && (
                    <>
                        <Text style={{ color: headlineTone === 'secondary' ? theme.colors.text : toneColor(theme, headlineTone), fontSize: 30, lineHeight: 36, letterSpacing: -0.5, ...Typography.mono('semiBold') }}>
                            {t('plugins.limits.percentLeft', { percent: 100 - Math.round(tightest.used) })}
                        </Text>
                        <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 2 }}>
                            {[tightest.label, tightest.resetsIn === undefined ? undefined : t('plugins.rightNow.resetsIn', { time: tightest.resetsIn })].filter((part) => part !== undefined).join(' · ')}
                        </Text>
                    </>
                )}
                {payload.windows.length > 0 && <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.divider, marginTop: 12, marginBottom: 12 }} />}
                {payload.windows.map((window, index) => {
                    const run = runOut(window);
                    const tone: PluginScreenTone | undefined = run?.tone ?? (window.pace == null || window.pace === 'on pace' ? undefined : verdictTone(window.pace));
                    return (
                        <View key={`${window.label}-${index}`} style={index === payload.windows.length - 1 ? undefined : { marginBottom: 12 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                                <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 13, flex: 1 }}>
                                    {window.label}
                                    {window.window !== undefined && <Text style={{ color: theme.colors.textSecondary }}>{` · ${window.window}`}</Text>}
                                </Text>
                                <Text style={{ color: tone === undefined ? theme.colors.text : toneColor(theme, tone), fontSize: 12.5, ...Typography.mono('semiBold') }}>{t('plugins.limits.percentLeft', { percent: 100 - Math.round(window.used) })}</Text>
                            </View>
                            {(window.resetsIn !== undefined || window.pace != null) && (
                                <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 4, marginTop: 3, marginBottom: 5 }}>
                                    {window.resetsIn !== undefined && <Text style={{ color: theme.colors.textSecondary, fontSize: 11.5, ...Typography.mono('regular') }}>{t('plugins.rightNow.resetsIn', { time: window.resetsIn })}</Text>}
                                    {window.pace != null && <Text style={{ color: tone === undefined ? theme.colors.text : toneColor(theme, tone), fontSize: 11.5 }}>{run?.note ?? t(PACE_KEYS[window.pace])}</Text>}
                                </View>
                            )}
                            {/* Drains with what is left, as its figure says; the tick marks the time left. */}
                            <Meter ratio={1 - window.used / 100} emphasis={0.9} marker={window.elapsed === undefined ? undefined : 1 - window.elapsed} />
                        </View>
                    );
                })}
                {asOf !== undefined && <Text style={{ color: theme.colors.textSecondary, fontSize: 11.5, lineHeight: 16, marginTop: 10, ...Typography.mono('regular') }}>{asOf}</Text>}
            </View>
        </View>
    );
}
