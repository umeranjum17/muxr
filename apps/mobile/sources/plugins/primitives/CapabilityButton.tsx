import * as React from 'react';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { useRealtimeSessionState } from '@/realtime/realtimeSessionState';
import { RealtimeGlyph } from '@/realtime/RealtimeGlyph';
import { withAlpha } from '@/components/ui';
import type { PrimitiveProps } from '../primitiveTypes'
import { capabilityFor } from '../capabilityRegistry';
import { resolvePluginText } from '../pluginText';
import { pluginSnapshot } from '../pluginStore';
import { t } from '@/text';

/** Generic icon control for one declared phone capability. */
export function CapabilityButton({ context, contribution, pluginId, manifestHash, onNavigate }: PrimitiveProps & { onNavigate?: () => void }) {
    const { theme } = useUnistyles();
    const realtime = useRealtimeSessionState();
    const capability = contribution.capability!;
    const manifest = pluginSnapshot().find((entry) => entry.summary.pluginId === pluginId && entry.summary.manifestHash === manifestHash)?.manifest;
    const handler = manifest === undefined ? undefined : capabilityFor(capability, manifest);
    const available = handler !== undefined;
    const icon = contribution.icon!;
    const label = resolvePluginText(contribution.accessibilityLabel!);
    const showsRealtime = contribution.indicator === 'realtime-session';
    const connecting = showsRealtime && realtime.state === 'connecting';
    const active = showsRealtime && realtime.state !== 'disconnected';
    const sessionId = 'sessionId' in context ? context.sessionId : '';
    const tint = active ? theme.colors.accent : theme.colors.textSecondary;
    return <Pressable
        onPress={() => { if (handler !== undefined) { onNavigate?.(); void handler({ sessionId, status: '', from: '' }); } }}
        disabled={!available}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={available ? label : `${label} ${t('plugins.unavailableSuffix')}`}
        accessibilityState={{ busy: connecting, selected: active, disabled: !available }}
        style={({ pressed }) => ({
            width: 44,
            height: 44,
            borderRadius: 22,
            alignItems: 'center',
            justifyContent: 'center',
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
        {showsRealtime
            ? <RealtimeGlyph size={22} state={realtime.state} color={tint} />
            : <Ionicons name={icon as never} size={22} color={tint} />}
    </Pressable>;
}
