import * as React from 'react';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { withAlpha } from '@/components/ui';
import { RealtimeGlyph } from './RealtimeGlyph';
import { useRealtimeSessionState } from '../application/realtimeSessionState';
import { startRealtimeCapability } from '../application/startRealtimeCapability';

/**
 * The realtime voice entry point, in whichever composer hosts it.
 *
 * Realtime voice is product code, so this control is rendered here rather than
 * declared by a plugin contribution. It keeps the exact surface the voice
 * plugin used: a bare pulse line that fills only while a session is live, so
 * the dictation mic beside it stays the only audio glyph in the composer.
 */
export function RealtimeTalkButton({ sessionId = '', accessibilityLabel, size = 44 }: { sessionId?: string; accessibilityLabel: string; size?: number }) {
    const { theme } = useUnistyles();
    const realtime = useRealtimeSessionState();
    const connecting = realtime.state === 'connecting';
    const active = realtime.state !== 'disconnected';
    const tint = active ? theme.colors.accent : theme.colors.textSecondary;
    return <Pressable
        onPress={() => { void startRealtimeCapability({ ...(sessionId === '' ? {} : { sessionId }) }); }}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ busy: connecting, selected: active }}
        style={({ pressed }) => ({
            width: size, height: size, borderRadius: size / 2,
            alignItems: 'center', justifyContent: 'center',
            backgroundColor: active ? withAlpha(theme.colors.accent, 0.16) : 'transparent',
            opacity: pressed ? 0.7 : 1,
        })}
    >
        <RealtimeGlyph size={Math.round(size * 0.45)} state={realtime.state} color={tint} />
    </Pressable>;
}
