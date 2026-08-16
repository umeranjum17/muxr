import * as React from 'react';
import { BackHandler, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { RealtimeSessionVisual } from './RealtimeSessionVisual';
import {
    rememberedRealtimeSession,
    startRealtimeSession,
    stopRealtimeSession,
    toggleRealtimeMuted,
    useRealtimeMuted,
    useRealtimeSessionState,
    useRealtimeTurns,
} from './realtimeSessionState';

export const RealtimeConversation = React.memo(function RealtimeConversation({
    visible,
    onClose,
}: {
    visible: boolean;
    onClose: () => void;
}) {
    const insets = useSafeAreaInsets();
    const { state, detail } = useRealtimeSessionState();
    const turns = useRealtimeTurns();
    const muted = useRealtimeMuted();
    const previousState = React.useRef(state);

    React.useEffect(() => {
        if (!visible || previousState.current === state) return;
        previousState.current = state;
        if (state === 'connected') void Haptics.selectionAsync();
        else if (state === 'speaking') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }, [state, visible]);

    React.useEffect(() => {
        if (!visible) return;
        return BackHandler.addEventListener('hardwareBackPress', () => {
            onClose();
            return true;
        }).remove;
    }, [onClose, visible]);

    if (!visible) return null;

    const speaking = state === 'speaking';
    const status = detail ?? (state === 'disconnected'
        ? 'Asleep — tap the mic to wake'
        : state === 'connecting'
          ? 'Connecting…'
          : state === 'thinking'
            ? 'Thinking…'
            : speaking
              ? 'Speaking'
              : muted
              ? 'Microphone muted'
              : 'Listening');
    const latest = turns.at(-1)?.text;

    return (
        <Animated.View
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(140)}
            accessibilityViewIsModal
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 1000,
                backgroundColor: '#050608',
                paddingTop: insets.top,
            }}
        >
            <View style={{ height: 64, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18 }}>
                <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Minimize realtime conversation" style={smallCircle}>
                    <Ionicons name="chevron-down" size={24} color="#f3f4f7" />
                </Pressable>
                <Text style={{ color: '#f3f4f7', fontSize: 16, fontWeight: '600', ...Typography.default('semiBold') }}>
                    Realtime
                </Text>
                <View style={{ width: 44 }} />
            </View>

            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, gap: 28 }}>
                <RealtimeSessionVisual size={238} state={state} muted={muted} />
                <View style={{ minHeight: 104, alignItems: 'center', gap: 10 }}>
                    <Text style={{ color: '#f7f8fb', fontSize: 28, lineHeight: 34, textAlign: 'center', ...Typography.default('semiBold') }}>
                        {status}
                    </Text>
                    {latest === undefined ? null : (
                        <Text numberOfLines={3} style={{ color: '#aeb4c0', fontSize: 16, lineHeight: 22, textAlign: 'center', ...Typography.default() }}>
                            {latest}
                        </Text>
                    )}
                </View>
            </View>

            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 28, paddingBottom: insets.bottom + 28 }}>
                {state === 'disconnected'
                    ? <Pressable
                        onPress={() => { const target = rememberedRealtimeSession(); if (target !== null) startRealtimeSession(target); }}
                        hitSlop={10}
                        accessibilityLabel="Start realtime conversation"
                        style={circle('#23262c')}
                    >
                        <Ionicons name="mic" size={25} color="#fff" />
                    </Pressable>
                    : <Pressable
                        onPress={toggleRealtimeMuted}
                        hitSlop={10}
                        accessibilityLabel={muted ? 'Unmute microphone' : 'Mute microphone'}
                        style={circle(muted ? '#f7f8fb' : '#23262c')}
                    >
                        <Ionicons name={muted ? 'mic-off' : 'mic'} size={25} color={muted ? '#111318' : '#fff'} />
                    </Pressable>}
                <Pressable
                    onPress={() => {
                        onClose();
                        stopRealtimeSession();
                    }}
                    hitSlop={10}
                    accessibilityLabel="End realtime conversation"
                    style={circle('#f7f8fb')}
                >
                    <Ionicons name="close" size={30} color="#111318" />
                </Pressable>
            </View>
        </Animated.View>
    );
});

const smallCircle = {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    backgroundColor: '#202329',
};

const circle = (backgroundColor: string) => ({
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    backgroundColor,
});
