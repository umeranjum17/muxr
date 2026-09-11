import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { useRealtimeSessionState } from '@/conversation/session';
import { RealtimeGlyph } from '@/conversation/ui';
import { withAlpha } from '@/components/ui';
import { PanelIcon, panelPalette } from '@/components/ActionShortcut';
import { Typography } from '@/constants/Typography';
import type { PrimitiveProps } from '../../domain/primitiveTypes'
import { capabilityFor } from '../../application/capabilityRegistry';
import { resolvePluginText } from '../../domain/pluginText';
import { pluginSnapshot } from '../../application/pluginStore';
import { t } from '@/text';

/** Generic icon control for one declared phone capability. */
export function CapabilityButton({ context, contribution, pluginId, manifestHash, onNavigate, presentation }: PrimitiveProps & { onNavigate?: () => void; presentation?: 'shortcut' }) {
    const { theme } = useUnistyles();
    const panel = panelPalette(theme);
    const realtime = useRealtimeSessionState();
    const capability = contribution.capability!;
    const manifest = pluginSnapshot().find((entry) => entry.summary.pluginId === pluginId && entry.summary.manifestHash === manifestHash)?.manifest;
    const handler = manifest === undefined ? undefined : capabilityFor(capability, manifest);
    // Voice talks to an agent: on a plain shell the control says so instead
    // of starting a session the host would refuse.
    const needsAgent = capability === 'voice.start' && 'hasAgent' in context && context.hasAgent === false;
    const available = handler !== undefined && !needsAgent;
    const icon = contribution.icon!;
    const label = resolvePluginText(contribution.accessibilityLabel!);
    const showsRealtime = contribution.indicator === 'realtime-session';
    const connecting = showsRealtime && realtime.state === 'connecting';
    const active = showsRealtime && realtime.state !== 'disconnected';
    const sessionId = 'sessionId' in context ? context.sessionId : '';
    const shortcut = presentation === 'shortcut';
    // In the panel the row's glyph carries the panel's own ink, like every
    // neighbouring row; elsewhere it stays the composer's secondary control.
    let tint = theme.colors.textSecondary;
    if (active) tint = theme.colors.accent;
    else if (shortcut) tint = panel.text;
    return <Pressable
        onPress={() => { if (handler !== undefined) { onNavigate?.(); void handler({ sessionId, status: '', from: '' }); } }}
        disabled={!available}
        hitSlop={presentation === undefined ? 6 : 0}
        accessibilityRole="button"
        accessibilityLabel={available ? label : `${label} ${needsAgent ? t('plugins.needsAgentSuffix') : t('plugins.unavailableSuffix')}`}
        accessibilityState={{ busy: connecting, selected: active, disabled: !available }}
        style={({ pressed }) => shortcut ? ({
            minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12,
            paddingHorizontal: 10, borderRadius: 10,
            backgroundColor: pressed ? panel.pressed : 'transparent',
            opacity: available ? (pressed ? 0.7 : 1) : 0.4,
        }) : ({
            width: 44, height: 44, borderRadius: 22,
            alignItems: 'center', justifyContent: 'center',
            // Bare until it is live: an always-on pill made this sit in the
            // composer as a widget beside the chrome-free dictation mic instead
            // of as its peer. The state pays for the fill.
            backgroundColor: active ? withAlpha(theme.colors.accent, 0.16) : 'transparent',
            opacity: available ? (pressed ? 0.7 : 1) : 0.4,
        })}
    >
        {/* The realtime control is a pulse line: the mic beside it is what you
            speak into, and a second audio glyph there would read as a second
            way to dictate. */}
        <View style={shortcut ? { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' } : undefined}>
            {showsRealtime
                ? <RealtimeGlyph size={22} state={realtime.state} color={tint} />
                : shortcut ? <PanelIcon icon={icon} color={tint} /> : <Ionicons name={icon as never} size={22} color={tint} />}
        </View>
        {/* Wraps like every other panel row: at large font sizes a truncated
            plugin label hides the row's whole point. */}
        {shortcut && <Text style={{ flex: 1, color: panel.text, fontSize: 15, lineHeight: 20, ...Typography.mono('regular') }}>{label}</Text>}
    </Pressable>;
}
