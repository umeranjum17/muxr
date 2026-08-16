import * as React from 'react';
import { ActivityIndicator, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { useRealtimeSessionState } from '@/realtime/realtimeSessionState';
import type { PrimitiveProps } from '../primitiveRegistry';
import { capabilityFor } from '../capabilityRegistry';
import { resolvePluginText } from '../pluginText';
import { pluginSnapshot } from '../pluginStore';
import { t } from '@/text';

/** Generic icon control for one declared phone capability. */
export function CapabilityButton({ context, contribution, pluginId, manifestHash }: PrimitiveProps) {
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
    return <Pressable
        onPress={() => { if (handler !== undefined) void handler({ sessionId, status: '', from: '' }); }}
        disabled={!available}
        accessibilityRole="button"
        accessibilityLabel={available ? label : `${label} ${t('plugins.unavailableSuffix')}`}
        accessibilityState={{ busy: connecting, selected: active, disabled: !available }}
        style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? theme.colors.accent : theme.colors.surfaceHigh, opacity: available ? 1 : 0.4 }}
    >
        {connecting
            ? <ActivityIndicator size="small" color={active ? '#fff' : theme.colors.textSecondary} />
            : <Ionicons name={icon as never} size={22} color={active ? '#fff' : theme.colors.textSecondary} />}
    </Pressable>;
}
