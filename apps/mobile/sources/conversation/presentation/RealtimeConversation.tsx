import * as React from 'react';
import { BackHandler, Pressable, ScrollView, View } from 'react-native';
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
    const { state, detail } = useRealtimeSessionState();
    const turns = useRealtimeTurns();
    const muted = useRealtimeMuted();
    const watching = useRealtimeWatching();
    const previousState = React.useRef(state);
    const [detailOpen, setDetailOpen] = React.useState(false);
    // How much room the layout actually gave the cloud, reported by the
    // measuring box below. Only ever written by onLayout: a measurement is
    // kept until a newer one arrives and never reset, because onLayout only
    // fires when the box's own metrics change -- a forgotten measurement can
    // never come back. Unmeasured, the cloud draws at full size and the box
    // clips it, so there is nothing to recover later.
    const [orbRoom, setOrbRoom] = React.useState<number | undefined>(undefined);
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
    // The cloud's room is deliberately NOT reset here: onLayout only fires when
    // the box's own metrics change, so a zeroed measurement could never come
    // back. A stale one is harmless -- the box clips the cloud for the frame
    // until a fresh report lands.
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
    // Only a stopped call is a failure. A detail arriving while connecting is
    // progress -- "Connecting secure voice media", "Reconnecting voice stream"
    // -- and reading it as a failure would put a red "Voice stopped." on every
    // successful call.
    const failure = state === 'disconnected' && detail !== undefined
        ? voiceFailure(detail, machineName)
        : undefined;
    // The cloud is decoration and the words are the point, so the cloud is what
    // yields: it asks for its full size and shrinks from there, and the layout
    // engine decides by how much. Below the size it was drawn for it stops being
    // a cloud, so it leaves rather than smudge. Unmeasured, full size -- the box
    // clips it, and the first report trues it up.
    const orbSize = Math.min(ORB_SIZE, orbRoom ?? ORB_SIZE);

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
                {/* The measuring box. Base size is the cloud's full size; it
                    shrinks against its siblings, so when the words grow, the
                    box is what yields and its onLayout reports the real room.
                    overflow hidden turns a stale-too-large cloud into a
                    one-frame clip instead of a smear across the words, and the
                    negative side margins cancel the column's padding so the
                    box is wider than the cloud and the clip never shaves it
                    in steady state. */}
                <View
                    onLayout={(event) => {
                        const next = Math.floor(event.nativeEvent.layout.height);
                        setOrbRoom((previous) => (previous === next ? previous : next));
                    }}
                    style={{ flexBasis: ORB_SIZE, flexShrink: ORB_YIELDS_FIRST, minHeight: 0, alignSelf: 'stretch', marginHorizontal: -24, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}
                >
                    {orbSize >= ORB_SMALLEST && <RealtimeSessionVisual size={orbSize} state={state} muted={muted} />}
                </View>
                {/* Scrolls rather than paints over the talk buttons: at a large
                    OS font size the label and the banner outgrow any viewport,
                    and there is nothing here that may be clipped to make it fit.
                    A sibling of the transcript, never nested in it -- a stopped
                    call has no turns, so the two are never on screen together. */}
                <ScrollView
                    style={{ alignSelf: 'stretch', flexGrow: 0, flexShrink: 1, minHeight: 0 }}
                    contentContainerStyle={{ alignItems: 'center', gap: 18 }}
                >
                    <Text style={{ color: '#f7f8fb', fontSize: 22, lineHeight: 28, textAlign: 'center', ...Typography.default('semiBold') }}>
                        {status}
                    </Text>
                    {activity !== undefined && (
                        <Text numberOfLines={1} style={{ color: '#8f96a3', fontSize: 12, lineHeight: 16, ...Typography.mono('regular') }}>
                            {activity}
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
                            <Pressable
                                onPress={() => setDetailOpen(!detailOpen)}
                                hitSlop={6}
                                accessibilityRole="button"
                                accessibilityLabel={detailOpen ? 'Hide details' : 'Show details'}
                                style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 4 }}
                            >
                                <Ionicons name={detailOpen ? 'chevron-down' : 'chevron-forward'} size={13} color="#ff9e96" />
                                <Text style={{ color: '#ff9e96', fontSize: 13, lineHeight: 18, ...Typography.default() }}>Details</Text>
                            </Pressable>
                            {detailOpen && (
                                // Whole, at its natural height. The column above
                                // scrolls it into reach; nothing here truncates.
                                <Text selectable style={{ color: '#ff9e96', fontSize: 12, lineHeight: 16, ...Typography.mono('regular') }}>
                                    {failure.detail}
                                </Text>
                            )}
                        </View>
                    )}
                </ScrollView>
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

/** The size the dust cloud is drawn for; it shrinks from here when the words need the room. */
const ORB_SIZE = 240;
/**
 * Shrink weight, not a size. Flex divides a shortfall across everything that can
 * give, in proportion to what each is holding, so any finite weight still takes
 * some off the words while the cloud has room left. The slice shrinks as the
 * weight grows but never reaches zero, so this sits past where it rounds away:
 * the cloud is spent first, and only then do the words begin to scroll.
 */
const ORB_YIELDS_FIRST = 1000;
/** Below this the cloud has no stars and reads as a speck, so it is absent instead. The overlay pill's size, its smallest designed one. */
const ORB_SMALLEST = 40;


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
