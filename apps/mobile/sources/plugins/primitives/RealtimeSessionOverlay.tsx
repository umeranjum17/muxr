import * as React from 'react';
import { Dimensions, Platform, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/StyledText';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    FadeIn,
    FadeOut,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { RealtimeConversation } from '@/realtime/RealtimeConversation';
import { RealtimeSessionVisual } from '@/realtime/RealtimeSessionVisual';
import { useUnistyles } from 'react-native-unistyles';
import { mountPrimitive } from '../primitivePresence';
import { t } from '@/text';
import {
    closeRealtimeConversation,
    openRealtimeConversation,
    useRealtimeConversationVisible,
    useRealtimeMuted,
    useRealtimeSessionState,
    stopRealtimeSession,
} from '@/realtime/realtimeSessionState';

const WIDTH = 154;
const HEIGHT = 58;
const ORB_SIZE = 40;
const MARGIN = 12;

/** The floating conversation control, above every screen. */
export const RealtimeSessionOverlay = React.memo(function RealtimeSessionOverlay() {
    const { theme } = useUnistyles();
    const { state, detail } = useRealtimeSessionState();
    const safeArea = useSafeAreaInsets();
    React.useEffect(() => mountPrimitive('realtime-session-overlay'), []);
    React.useEffect(() => () => stopRealtimeSession(), []);
    const muted = useRealtimeMuted();
    const open = state !== 'disconnected';
    const failed = !open && detail !== undefined;
    const sessionLabel = state === 'connecting'
        ? t('plugins.realtimeConnecting')
        : state === 'connected'
          ? t('plugins.realtimeListening')
          : state === 'thinking'
            ? t('plugins.realtimeThinking')
            : state === 'speaking'
              ? t('plugins.realtimeSpeaking')
            : failed
              ? t('plugins.realtimeError')
              : t('plugins.realtimeOff');
    const conversationVisible = useRealtimeConversationVisible();

    const window = Dimensions.get('window');
    const x = useSharedValue(window.width - WIDTH - MARGIN);
    const y = useSharedValue(window.height * 0.62);
    const startX = useSharedValue(0);
    const startY = useSharedValue(0);

    React.useEffect(() => {
        const clamp = ({ width, height }: { width: number; height: number }) => {
            const maxX = Math.max(MARGIN, width - WIDTH - MARGIN);
            const maxY = Math.max(safeArea.top + MARGIN, height - HEIGHT - safeArea.bottom - MARGIN);
            x.value = withSpring(Math.min(Math.max(x.value, MARGIN), maxX), { damping: 18 });
            y.value = withSpring(Math.min(Math.max(y.value, safeArea.top + MARGIN), maxY), { damping: 18 });
        };
        clamp(Dimensions.get('window'));
        const subscription = Dimensions.addEventListener('change', ({ window: nextWindow }) => clamp(nextWindow));
        return () => subscription.remove();
    }, [safeArea.bottom, safeArea.top, x, y]);

    const drag = React.useMemo(
        () =>
            Gesture.Pan()
                .onBegin(() => {
                    startX.value = x.value;
                    startY.value = y.value;
                })
                .onUpdate((event) => {
                    x.value = startX.value + event.translationX;
                    y.value = startY.value + event.translationY;
                })
                .onEnd(() => {
                    const { width, height } = Dimensions.get('window');
                    const toLeft = x.value + WIDTH / 2 < width / 2;
                    x.value = withSpring(toLeft ? MARGIN : Math.max(MARGIN, width - WIDTH - MARGIN), { damping: 18 });
                    const maxY = Math.max(safeArea.top + MARGIN, height - HEIGHT - safeArea.bottom - MARGIN);
                    y.value = withSpring(Math.min(Math.max(y.value, safeArea.top + MARGIN), maxY), { damping: 18 });
                }),
        [safeArea.bottom, safeArea.top, startX, startY, x, y],
    );

    const press = useSharedValue(1);
    const tap = React.useMemo(() => Gesture.Tap()
        .onBegin(() => { press.value = withTiming(0.97, { duration: 80 }); })
        .onFinalize(() => { press.value = withTiming(1, { duration: 160 }); })
        .onEnd(openRealtimeConversation)
        .runOnJS(true), [press]);

    const style = useAnimatedStyle(() => ({
        transform: [{ translateX: x.value }, { translateY: y.value }, { scale: press.value }],
    }));

    if (!open && !conversationVisible && !failed) return null;

    return (
        <>
            {(open || failed) && (
                <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
                    <GestureDetector gesture={Gesture.Race(drag, tap)}>
                        <Animated.View
                            entering={FadeIn.duration(180)}
                            exiting={FadeOut.duration(140)}
                            accessible
                            accessibilityRole="button"
                            accessibilityLabel={`${sessionLabel}. ${t('plugins.openConversation')}`}
                            accessibilityActions={Platform.OS === 'android' ? [{ name: 'activate' }] : undefined}
                            onAccessibilityAction={Platform.OS === 'android' ? ({ nativeEvent }) => {
                                if (nativeEvent.actionName === 'activate') openRealtimeConversation();
                            } : undefined}
                            onAccessibilityTap={Platform.OS === 'ios' ? openRealtimeConversation : undefined}
                            style={[
                                {
                                    position: 'absolute',
                                    width: WIDTH,
                                    height: HEIGHT,
                                    borderRadius: HEIGHT / 2,
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    paddingLeft: (HEIGHT - ORB_SIZE) / 2,
                                    paddingRight: 12,
                                    gap: 10,
                                    backgroundColor: theme.colors.surfaceHigh,
                                    borderWidth: 1,
                                    borderColor: muted ? theme.colors.textDestructive : theme.colors.divider,
                                },
                                style,
                            ]}
                        >
                            <RealtimeSessionVisual size={ORB_SIZE} state={state} muted={muted} />
                            <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.text, fontSize: 13, fontWeight: '600' }}>
                                {sessionLabel}…
                            </Text>
                            <Ionicons name="chevron-up" size={16} color={theme.colors.textSecondary} />
                        </Animated.View>
                    </GestureDetector>
                </View>
            )}
            <RealtimeConversation visible={conversationVisible} onClose={closeRealtimeConversation} />
        </>
    );
});
