import * as React from 'react';
import { BackHandler, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useMachine, useSession } from '@/catalog/store';
import { getRigActivityIndicators, getRigIdentity } from '@/catalog';
import { RealtimeSessionVisual } from './RealtimeSessionVisual';
import {
    rememberedRealtimeSession,
    startRealtimeSession,
    stopRealtimeSession,
    toggleRealtimeMuted,
    useRealtimeMuted,
    useRealtimeSessionState,
    useRealtimeTurns,
    useRealtimeWatching,
} from '../application/realtimeSessionState';
import { realtimeCallLabel } from '../domain/micOwnership';
import { voiceFailure } from '../domain/voiceFailure';

export const RealtimeConversation = React.memo(function RealtimeConversation({
    visible,
    onClose,
}: {
    visible: boolean;
    onClose: () => void;
}) {
    const insets = useSafeAreaInsets();
    const { height } = useWindowDimensions();
    const { state, detail, everConnected } = useRealtimeSessionState();
    const turns = useRealtimeTurns();
    const muted = useRealtimeMuted();
    const watching = useRealtimeWatching();
    const previousState = React.useRef(state);
    const [detailOpen, setDetailOpen] = React.useState(false);
    const [columnHeight, setColumnHeight] = React.useState(0);
    const transcript = React.useRef<ScrollView>(null);
    // The voice is attached to a working session; what that session is doing is
    // the other half of "what is happening right now".
    const bound = rememberedRealtimeSession();
    const session = useSession(bound ?? '');
    // `session.metadata.host` is the machine id, which is an opaque server id on
    // a hosted pairing. The remedy names the computer the way every other screen
    // names it.
    const machine = useMachine(session?.metadata?.machineId ?? '');
    const machineName = machine?.metadata?.displayName || machine?.metadata?.host || 'your computer';
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

    // Collapsed every time this opens, and never yanked shut while it is open:
    // a watched agent retries voice on its own, reporting between each attempt.
    React.useEffect(() => { if (!visible) setDetailOpen(false); }, [visible]);

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
    // Only a stopped call is a failure. While connecting, a detail is progress
    // -- "Connecting secure voice media", "Reconnecting voice stream" -- and
    // reading it as a failure would put a red "Voice couldn't start." on every
    // successful call.
    const failure = state === 'disconnected' && detail !== undefined
        ? voiceFailure(detail, machineName, everConnected)
        : undefined;
    const progress = state === 'connecting' ? detail : undefined;
    // The cloud is decoration and the failure is the point. At a large display
    // scale the viewport is short enough that the cloud, the label and the talk
    // buttons already leave nothing over, so when there is something to say the
    // cloud gives back exactly what the message needs. Everything the cloud
    // yields to is measured as one column, never assumed: the label wraps to two
    // lines at this width, and every word here grows with the OS font size, so
    // any guessed height hands the surplus to the talk buttons.
    const room = height - insets.top - insets.bottom - AROUND_THE_CLOUD - columnHeight;
    const orbSize = failure === undefined ? 240 : Math.max(0, Math.min(240, room));

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
                {orbSize > 0 && <RealtimeSessionVisual size={orbSize} state={state} muted={muted} />}
                <View
                    onLayout={(event) => setColumnHeight(Math.ceil(event.nativeEvent.layout.height))}
                    style={{ alignSelf: 'stretch', alignItems: 'center', gap: 18 }}
                >
                    <Text style={{ color: '#f7f8fb', fontSize: 22, lineHeight: 28, textAlign: 'center', ...Typography.default('semiBold') }}>
                        {status}
                    </Text>
                    {activity !== undefined && (
                        <Text numberOfLines={1} style={{ color: '#8f96a3', fontSize: 12, lineHeight: 16, ...Typography.mono('regular') }}>
                            {activity}
                        </Text>
                    )}
                    {progress !== undefined && (
                        <Text style={{ color: '#8f96a3', fontSize: 13, lineHeight: 18, textAlign: 'center', ...Typography.default() }}>
                            {progress}
                        </Text>
                    )}
                    {failure !== undefined && (
                        <View style={{ alignSelf: 'stretch', gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12, backgroundColor: 'rgba(255,69,58,0.12)' }}>
                            <View style={{ flexDirection: 'row', gap: 8 }}>
                                <Ionicons name="alert-circle-outline" size={16} color="#ff6a5e" style={{ marginTop: 2 }} />
                                <View style={{ flex: 1, gap: 3 }}>
                                    <Text style={{ color: '#ffdad5', fontSize: 14, lineHeight: 19, ...Typography.default('semiBold') }}>
                                        {failure.headline}
                                    </Text>
                                    {failure.remedy !== undefined && (
                                        <Text style={{ color: '#ff9e96', fontSize: 13, lineHeight: 18, ...Typography.default() }}>
                                            {failure.remedy}
                                        </Text>
                                    )}
                                </View>
                            </View>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 18 }}>
                                <Pressable
                                    onPress={() => setDetailOpen(!detailOpen)}
                                    hitSlop={6}
                                    accessibilityRole="button"
                                    accessibilityLabel={detailOpen ? 'Hide details' : 'Show details'}
                                    style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
                                >
                                    <Ionicons name={detailOpen ? 'chevron-down' : 'chevron-forward'} size={13} color="#ff9e96" />
                                    <Text style={{ color: '#ff9e96', fontSize: 13, lineHeight: 18, ...Typography.default() }}>Details</Text>
                                </Pressable>
                            </View>
                            {detailOpen && (
                                // A column child, so the provider's words wrap to the
                                // banner and scroll: whole text, never an ellipsis.
                                <ScrollView style={{ maxHeight: DETAIL_HEIGHT }} nestedScrollEnabled showsVerticalScrollIndicator={false}>
                                    <Text selectable style={{ color: '#ff9e96', fontSize: 12, lineHeight: 16, ...Typography.mono('regular') }}>
                                        {failure.detail}
                                    </Text>
                                </ScrollView>
                            )}
                        </View>
                    )}
                </View>
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

/** The provider's words get a readable window and scroll past it. */
const DETAIL_HEIGHT = 132;
/** The fixed furniture only: header, talk buttons, paddings and gaps. Everything with words in it measures itself. */
const AROUND_THE_CLOUD = 198;

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
