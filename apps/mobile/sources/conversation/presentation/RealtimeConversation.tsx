import * as React from 'react';
import { BackHandler, Pressable, ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useSession } from '@/sync/storage';
import { getRigActivityIndicators, getRigIdentity } from '@/sync/rig';
import { RealtimeSessionVisual } from '@/realtime/RealtimeSessionVisual';
import {
    rememberedRealtimeSession,
    startRealtimeSession,
    stopRealtimeSession,
    toggleRealtimeMuted,
    useRealtimeMuted,
    useRealtimeSessionState,
    useRealtimeTurns,
    useRealtimeWatching,
} from '@/realtime/realtimeSessionState';
import { realtimeCallLabel } from '../domain/micOwnership';

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
    const watching = useRealtimeWatching();
    const previousState = React.useRef(state);
    const transcript = React.useRef<ScrollView>(null);
    // The voice is attached to a working session; what that session is doing is
    // the other half of "what is happening right now".
    const bound = rememberedRealtimeSession();
    const session = useSession(bound ?? '');
    const micLabel = muted ? 'Unmute microphone' : 'Mute microphone';
    const micFill = muted ? '#f7f8fb' : '#23262c';
    const micIcon = muted ? 'mic-off' : 'mic';
    const micColor = muted ? '#111318' : '#fff';
    const activity = React.useMemo(() => {
        const identity = getRigIdentity(session?.metadata);
        const indicators = getRigActivityIndicators(session?.metadata)
            .map((item) => `${item.count}${item.queued === undefined || item.queued === 0 ? '' : `+${item.queued}`} ${item.key}`);
        return [identity?.modelName, ...indicators].filter((part) => part !== undefined && part !== null && part !== '').join(' · ') || undefined;
    }, [session?.metadata]);

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
    const status = realtimeCallLabel(state, watching, muted, speaking);
    const failure = state === 'disconnected' || state === 'connecting' ? detail : undefined;

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

            <View style={{ flex: 1, alignItems: 'center', paddingHorizontal: 24, paddingTop: 8, gap: 18 }}>
                <RealtimeSessionVisual size={240} state={state} muted={muted} />
                <Text style={{ color: '#f7f8fb', fontSize: 22, lineHeight: 28, textAlign: 'center', ...Typography.default('semiBold') }}>
                    {status}
                </Text>
                {activity !== undefined && (
                    <Text numberOfLines={1} style={{ color: '#8f96a3', fontSize: 12, lineHeight: 16, ...Typography.mono('regular') }}>
                        {activity}
                    </Text>
                )}
                {failure !== undefined && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: '100%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: 'rgba(255,69,58,0.12)' }}>
                        <Ionicons name="alert-circle-outline" size={14} color="#ff6a5e" />
                        <Text numberOfLines={2} style={{ color: '#ff9e96', fontSize: 12, lineHeight: 16, flexShrink: 1, ...Typography.mono('regular') }}>{failure}</Text>
                    </View>
                )}
                {/* What it heard and what it said, in order: a single latest line
                    hid the half of the conversation you wanted to check. */}
                <ScrollView ref={transcript} style={{ flex: 1, alignSelf: 'stretch' }} contentContainerStyle={{ paddingVertical: 8, gap: 10 }}
                    showsVerticalScrollIndicator={false}
                    onContentSizeChange={() => transcript.current?.scrollToEnd({ animated: true })}>
                    {turns.slice(-24).map((turn) => (
                        <View key={turn.id} style={{ flexDirection: 'row', gap: 10 }}>
                            <Text style={{ color: turn.role === 'agent' ? '#7f8794' : '#5d636e', fontSize: 11, lineHeight: 21, width: 34, ...Typography.mono('regular') }}>
                                {turn.role === 'agent' ? 'it' : 'you'}
                            </Text>
                            <Text style={{ color: turn.role === 'agent' ? '#e9ebf0' : '#9aa1ad', fontSize: 15, lineHeight: 21, flex: 1, ...Typography.default() }}>
                                {turn.text}
                            </Text>
                        </View>
                    ))}
                </ScrollView>
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
                        accessibilityLabel={micLabel}
                        style={circle(micFill)}
                    >
                        <Ionicons name={micIcon} size={25} color={micColor} />
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
