import * as React from 'react';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { useRealtimeSessionState } from '@/realtime/realtimeSessionState';
import { RealtimeGlyph } from '@/realtime/RealtimeGlyph';
import { withAlpha } from '@/components/ui';
import type { PrimitiveProps } from '../primitiveRegistry';
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
            width: 42,
            height: 42,
            borderRadius: 21,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: active ? withAlpha(theme.colors.accent, 0.16) : theme.colors.surfaceHigh,
            opacity: available ? (pressed ? 0.7 : 1) : 0.4,
        })}
    >
        {/* The realtime control draws the thing it opens, small: a lit core with
            one orbit. A glyph from the icon set says headset or radio, and both
            promise hardware rather than a voice. */}
        {showsRealtime
            ? <RealtimeGlyph size={22} state={realtime.state} color={tint} />
            : <Ionicons name={icon as never} size={22} color={tint} />}
    </Pressable>;
}
