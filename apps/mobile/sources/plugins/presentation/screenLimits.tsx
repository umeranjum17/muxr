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

/** Share of a window used at which the row turns warning, then danger. The
 *  host decided the verdict; these only colour the evidence rows. */
const ROW_WATCH = 75;
const ROW_LOW = 90;

const rowTone = (used: number): PluginScreenTone => {
    if (used >= ROW_LOW) return 'danger';
    if (used >= ROW_WATCH) return 'warning';
    return 'positive';
};

const VERDICT_WORDS: Record<Exclude<PluginLimitsPayload['verdict'], 'unknown'>, string> = {
    limited: 'Rate limited',
    low: 'Nearly out',
    watch: 'Pace yourself',
    ahead: 'Ahead of pace',
    go: 'Go ahead',
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
    const verdict = payload.verdict === 'unknown' ? undefined : VERDICT_WORDS[payload.verdict];
    const head = [verdict, tightest === undefined ? undefined : `${100 - Math.round(tightest.used)} percent left`]
        .filter((part) => part !== undefined).join(', ');
    const rows = payload.windows.map((window) => {
        const parts = [`${window.label} ${Math.round(window.used)} percent used`];
        if (window.resetsIn !== undefined) parts.push(`resets in ${window.resetsIn}`);
        return parts.join(', ');
    });
    return [`${payload.plan ?? 'Right now'}: ${head}`, ...rows].join('. ');
}

/**
 * "Can I start a task right now, and when do I get more": one verdict word,
 * one headroom headline, then every window as evidence against the same 100
 * ceiling. The host normalizes each provider into the payload; this renderer
 * never learns a provider's name.
 */
export function ScreenLimits({ node, data }: { node: PluginScreenLimitsNode; data: unknown }) {
    const { theme } = useUnistyles();
    const payload = asLimitsPayload(resolvePath(data, node.path));
    const title = node.title === undefined ? undefined : bindText(resolvePluginText(node.title), data);
    // Nothing to answer with: the section label plus the host's quiet line,
    // following the chart empty-state precedent (no card).
    if (payload.verdict === 'unknown' && payload.windows.length === 0) {
        const message = payload.message ?? '';
        const empty = node.emptyText === undefined ? '' : bindText(resolvePluginText(node.emptyText), data);
        const line = message !== '' ? message : empty;
        if (line === '' && title === undefined) return null;
        return (
            <View style={{ marginBottom: 12 }}>
                {title !== undefined && <SectionLabel>{title}</SectionLabel>}
                {line !== '' && <Text style={{ color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 6 }}>{line}</Text>}
            </View>
        );
    }
    const tightest = bindingWindow(payload.windows);
    const verdictWord = payload.verdict === 'unknown' ? undefined : VERDICT_WORDS[payload.verdict];
    const verdictTone: PluginScreenTone = payload.verdict === 'go' ? 'positive' : payload.verdict === 'unknown' ? 'secondary' : payload.verdict === 'watch' || payload.verdict === 'ahead' ? 'warning' : 'danger';
    const headlineTone: PluginScreenTone = payload.verdict === 'go' ? 'secondary' : verdictTone;
    return (
        <View
            accessible
            accessibilityLabel={limitsSummary(payload)}
            style={[cardStyle(theme), { padding: 16, paddingTop: 14, marginBottom: 12 }]}
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                {title !== undefined && <SectionLabel>{title}</SectionLabel>}
                {payload.plan !== undefined && (
                    <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 11.5, ...Typography.mono('regular') }}>{payload.plan}</Text>
                )}
            </View>
            {verdictWord !== undefined && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: toneColor(theme, verdictTone) }} />
                    <Text style={{ color: theme.colors.text, fontSize: 17, lineHeight: 22, fontWeight: '600', flex: 1, ...Typography.default('semiBold') }}>{verdictWord}</Text>
                </View>
            )}
            {tightest !== undefined && (
                <>
                    <Text style={{ color: headlineTone === 'secondary' ? theme.colors.text : toneColor(theme, headlineTone), fontSize: 30, lineHeight: 36, letterSpacing: -0.5, ...Typography.mono('semiBold') }}>
                        {`${100 - Math.round(tightest.used)}% left`}
                    </Text>
                    <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 2 }}>
                        {[tightest.label, tightest.resetsIn === undefined ? undefined : `resets in ${tightest.resetsIn}`].filter((part) => part !== undefined).join(' · ')}
                    </Text>
                </>
            )}
            {payload.windows.length > 0 && <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.divider, marginTop: 12, marginBottom: 12 }} />}
            {payload.windows.map((window, index) => {
                const tone = rowTone(window.used);
                return (
                    <View key={`${window.label}-${index}`} style={index === payload.windows.length - 1 ? undefined : { marginBottom: 12 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'baseline', marginBottom: 5 }}>
                            <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 13, flex: 1, marginRight: 12 }}>
                                {window.window === undefined ? window.label : `${window.label} · ${window.window}`}
                            </Text>
                            <Text style={{ color: toneColor(theme, tone), fontSize: 12.5, ...Typography.mono('semiBold') }}>{`${Math.round(window.used)}% used`}</Text>
                            {window.resetsIn !== undefined && (
                                <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 11.5, marginLeft: 8, ...Typography.mono('regular') }}>{`resets in ${window.resetsIn}`}</Text>
                            )}
                        </View>
                        {/* Every window draws against the same 100 ceiling; the
                            tick is where the window stands, so a fill far past
                            it reads as burning fast without a word. */}
                        <Meter ratio={window.used / 100} emphasis={0.9} marker={window.elapsed} />
                    </View>
                );
            })}
        </View>
    );
}
