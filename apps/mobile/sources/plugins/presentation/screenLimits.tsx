import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { PluginScreenLimitsNode, PluginScreenTone } from '@muxr/contract';
import { asLimitsPayload, type PluginLimitsPayload, type PluginLimitsWindow } from '../domain/limitsModel';
import { resolvePath, bindText } from '../domain/screenModel';
import { resolvePluginText } from '../domain/pluginText';
import { toneColor } from '../domain/pluginTone';
import { cardStyle, SectionLabel, Meter } from '@/components/ui';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/** Share of a window used at which the row turns warning, then danger. The
 *  host decided the verdict; these only colour the evidence rows. */
const ROW_WATCH = 75;
const ROW_LOW = 90;

/** The card's inner width below which a row's label, share and reset clock no
 *  longer fit one line ("Session · 5h", "90% used", "resets in 16d 23h").
 *  Narrower, the clock gets its own line so the label is never cut to a letter. */
const ONE_LINE_ROW = 290;

const rowTone = (used: number): PluginScreenTone => {
    if (used >= ROW_LOW) return 'danger';
    if (used >= ROW_WATCH) return 'warning';
    return 'positive';
};

/** One verdict vocabulary for every limit surface; the Right now card reads
 *  the same five words and the same five colours. */
export const verdictTone = (verdict: PluginLimitsPayload['verdict']): PluginScreenTone =>
    verdict === 'go' ? 'positive'
        : verdict === 'unknown' ? 'secondary'
            : verdict === 'watch' || verdict === 'ahead' ? 'warning'
                : 'danger';

export const VERDICT_KEYS: Record<Exclude<PluginLimitsPayload['verdict'], 'unknown'>, Parameters<typeof t>[0]> = {
    limited: 'plugins.limits.limited',
    low: 'plugins.limits.low',
    watch: 'plugins.limits.watch',
    ahead: 'plugins.limits.ahead',
    go: 'plugins.limits.go',
};

/** The tightest window leads the card: highest share used; on ties, the first
 *  published window wins (the host keeps provider order, so ties fall to the
 *  window the provider named first). */
function bindingWindow(windows: PluginLimitsWindow[]): PluginLimitsWindow | undefined {
    return windows.reduce<PluginLimitsWindow | undefined>((worst, window) =>
        worst === undefined || window.used > worst.used ? window : worst, undefined);
}

function limitsSummary(payload: PluginLimitsPayload): string {
    const tightest = bindingWindow(payload.windows);
    const verdict = payload.verdict === 'unknown' ? undefined : t(VERDICT_KEYS[payload.verdict]);
    const head = [verdict, tightest === undefined ? undefined : t('plugins.limits.percentLeft', { percent: 100 - Math.round(tightest.used) })]
        .filter((part) => part !== undefined).join(', ');
    const rows = payload.windows.map((window) => {
        const parts = [[window.label, t('plugins.limits.percentUsed', { percent: Math.round(window.used) })].join(' ')];
        if (window.resetsIn !== undefined) parts.push(t('plugins.rightNow.resetsIn', { time: window.resetsIn }));
        return parts.join(', ');
    });
    return [`${payload.plan ?? t('plugins.rightNow.title')}: ${head}`, ...rows].join('. ');
}

/**
 * "Can I start a task right now, and when do I get more": one verdict word,
 * one headroom headline, then every window as evidence against the same 100
 * ceiling. The host normalizes each provider into the payload; this renderer
 * never learns a provider's name.
 */
export function ScreenLimits({ node, data }: { node: PluginScreenLimitsNode; data: unknown }) {
    const { theme } = useUnistyles();
    const [innerWidth, setInnerWidth] = React.useState(0);
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
    const verdictWord = payload.verdict === 'unknown' ? undefined : t(VERDICT_KEYS[payload.verdict]);
    const tone = verdictTone(payload.verdict);
    const headlineTone: PluginScreenTone = payload.verdict === 'go' ? 'secondary' : tone;
    const stacked = innerWidth > 0 && innerWidth < ONE_LINE_ROW;
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
                accessibilityLabel={limitsSummary(payload)}
                style={[cardStyle(theme), { padding: 16, paddingTop: 14 }]}
                onLayout={(event) => setInnerWidth(event.nativeEvent.layout.width - 32)}
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
                    const tone = rowTone(window.used);
                    const reset = window.resetsIn === undefined ? undefined : t('plugins.rightNow.resetsIn', { time: window.resetsIn });
                    const resetStyle = { color: theme.colors.textSecondary, fontSize: 11.5, ...Typography.mono('regular') };
                    return (
                        <View key={`${window.label}-${index}`} style={index === payload.windows.length - 1 ? undefined : { marginBottom: 12 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'baseline', marginBottom: stacked && reset !== undefined ? 2 : 5 }}>
                                <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 13, flex: 1, marginRight: 12 }}>
                                    {window.label}
                                    {window.window !== undefined && <Text style={{ color: theme.colors.textSecondary }}>{` · ${window.window}`}</Text>}
                                </Text>
                                <Text style={{ color: toneColor(theme, tone), fontSize: 12.5, ...Typography.mono('semiBold') }}>{t('plugins.limits.percentUsed', { percent: Math.round(window.used) })}</Text>
                                {!stacked && reset !== undefined && <Text numberOfLines={1} style={[resetStyle, { marginLeft: 8 }]}>{reset}</Text>}
                            </View>
                            {stacked && reset !== undefined && <Text numberOfLines={1} style={[resetStyle, { marginBottom: 5 }]}>{reset}</Text>}
                            {/* Every window draws against the same 100 ceiling; the
                                tick is where the window stands, so a fill far past
                                it reads as burning fast without a word. */}
                            <Meter ratio={window.used / 100} emphasis={0.9} marker={window.elapsed} />
                        </View>
                    );
                })}
            </View>
        </View>
    );
}
