import * as React from 'react';
import { ActivityIndicator, AppState, Keyboard, Platform, Pressable, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useUnistyles } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useWebImeComposing } from '@/components/useWebImeComposing';
import { setBrowserPrivate } from '@/../modules/browser-privacy';
import type { SurfaceBrowserSessionOffer } from '@muxr/contract';
import { openTakeover, ownershipStrip, type TakeoverSession, type TakeoverSnapshot } from '@/takeover';
import { HostBrowserVideo } from './HostBrowserVideo';

/**
 * Agent browser: watch the agent's own browser, take it over for sign-in,
 * give it back. A fixed header carries the offer's human title, the safe
 * site hostname and the ownership strip; the body is the received video
 * behind a cover whenever nothing current may be shown (loading, paused,
 * checking, ended). Nothing here shows a port, id, token or URL query.
 *
 * Every input goes through the ownership machine, which refuses it unless
 * the seat, fresh media, geometry and a live permit all hold.
 */

const TAP_SLOP_PX = 12;
const TAP_TIMEOUT_MS = 400;
const PRIVATE_STATES = new Set(['taking-control', 'you-control', 'giving-back', 'paused']);

function useTakeover(machineId: string, session: string): [TakeoverSession, TakeoverSnapshot] {
    const ref = React.useRef<TakeoverSession | null>(null);
    if (ref.current === null) ref.current = openTakeover({ machineId, session });
    const takeover = ref.current;
    const snapshot = React.useSyncExternalStore(takeover.subscribe, takeover.snapshot, takeover.snapshot);
    React.useEffect(() => () => {
        // Closing the view while owning pauses the seat: input dies now, the
        // service keeps it Paused · Private, there is no timed handback.
        if (takeover.snapshot().status?.owner === 'self') void takeover.pause();
        takeover.close();
    }, [takeover]);
    return [takeover, snapshot];
}

function Action(props: { label: string; icon?: string; emphasis?: boolean; onPress: () => void }): React.JSX.Element {
    const { theme } = useUnistyles();
    return (
        <Pressable
            onPress={props.onPress}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={props.label}
            style={({ pressed }) => ({
                minHeight: 44,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 14,
                borderRadius: 12,
                backgroundColor: props.emphasis === true ? theme.colors.textLink : theme.colors.surfaceHigh,
                opacity: pressed ? 0.6 : 1,
            })}
        >
            {props.icon !== undefined && <Ionicons name={props.icon as never} size={18} color={props.emphasis === true ? '#fff' : theme.colors.text} />}
            <Text style={{ ...Typography.default('semiBold'), color: props.emphasis === true ? '#fff' : theme.colors.text }}>{props.label}</Text>
        </Pressable>
    );
}

function IconButton(props: { label: string; icon: string; disabled?: boolean; onPress: () => void }): React.JSX.Element {
    const { theme } = useUnistyles();
    return (
        <Pressable
            onPress={props.onPress}
            disabled={props.disabled === true}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={props.label}
            style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', opacity: props.disabled === true ? 0.35 : pressed ? 0.6 : 1 })}
        >
            <Ionicons name={props.icon as never} size={22} color={theme.colors.text} />
        </Pressable>
    );
}

export function HostBrowserView(props: {
    offer: SurfaceBrowserSessionOffer;
    machineId: string;
    registerBackHandler: (handler: (() => boolean) | null) => void;
    onReturnToAgent: () => void;
    onClose: () => void;
}): React.JSX.Element {
    const { theme } = useUnistyles();
    const [takeover, snapshot] = useTakeover(props.machineId, props.offer.session);
    const { state, status, inputUnlocked, field } = snapshot;
    const strip = ownershipStrip(state);
    const isPrivate = PRIVATE_STATES.has(state);
    const owning = status?.owner === 'self';
    const site = status?.site ?? props.offer.site;
    const [display, setDisplay] = React.useState({ width: 0, height: 0 });
    const displayRef = React.useRef(display);
    displayRef.current = display;
    const frameRef = React.useRef({ width: 0, height: 0 });
    const [zoomed, setZoomed] = React.useState(false);
    const [draft, setDraft] = React.useState('');
    const composerRef = React.useRef<TextInput>(null);
    const isComposingRef = useWebImeComposing(composerRef, field !== null);

    // Private on screen means private in the switcher and to screen capture.
    React.useEffect(() => {
        setBrowserPrivate(isPrivate);
        return () => { setBrowserPrivate(false); };
    }, [isPrivate]);

    // Background or a hidden tab pauses the seat at once; foreground asks
    // the authority what is true before offering Resume or Give back.
    React.useEffect(() => {
        const onChange = (active: boolean) => {
            if (active) void takeover.refresh();
            else if (owning) void takeover.pause();
        };
        if (Platform.OS === 'web' && typeof document !== 'undefined') {
            const listener = () => onChange(document.visibilityState === 'visible');
            document.addEventListener('visibilitychange', listener);
            return () => document.removeEventListener('visibilitychange', listener);
        }
        const subscription = AppState.addEventListener('change', (next) => onChange(next === 'active'));
        return () => subscription.remove();
    }, [takeover, owning]);

    // The composer follows acknowledged remote focus only; a secret field
    // starts as a local replacement entry and never sees a stored value.
    React.useEffect(() => {
        if (field === null) { setDraft(''); return; }
        const secret = field.kind === 'password' || field.kind === 'otp';
        setDraft(secret ? '' : (field.value ?? ''));
        composerRef.current?.focus();
    }, [field]);
    React.useEffect(() => { if (!inputUnlocked) setDraft(''); }, [inputUnlocked]);

    React.useEffect(() => {
        if (status?.navigation.canGoBack !== true || !inputUnlocked) { props.registerBackHandler(null); return; }
        props.registerBackHandler(() => takeover.navigate('back'));
        return () => props.registerBackHandler(null);
    }, [status?.navigation.canGoBack, inputUnlocked, props.registerBackHandler, takeover]);

    const onFrame = React.useCallback((frame: { width: number; height: number }) => {
        frameRef.current = frame;
        takeover.displayed(displayRef.current, frame);
    }, [takeover]);
    React.useEffect(() => { takeover.displayed(display, frameRef.current); }, [takeover, display]);
    const onPresented = React.useCallback((generation: number) => takeover.presented(generation), [takeover]);
    const onWheel = React.useCallback((point: { x: number; y: number }, deltaX: number, deltaY: number) => {
        if (!zoomed) takeover.wheel(point, deltaX, deltaY);
    }, [takeover, zoomed]);

    // Touch: a tap or a one-finger drag reaches the page as the touch it
    // was; pinch is local inspection and is never injected. While zoomed,
    // one finger pans the inspected view and the page gets nothing.
    const scale = useSharedValue(1);
    const x = useSharedValue(0);
    const y = useSharedValue(0);
    const startScale = useSharedValue(1);
    const startX = useSharedValue(0);
    const startY = useSharedValue(0);
    const setZoomState = React.useCallback((next: boolean) => setZoomed(next), []);
    const remoteTap = React.useCallback((px: number, py: number) => { takeover.tap({ x: px, y: py }); }, [takeover]);
    const remoteTouch = React.useCallback((phase: 'start' | 'move' | 'end', px?: number, py?: number) => {
        takeover.touch(phase, px === undefined || py === undefined ? undefined : { x: px, y: py });
    }, [takeover]);

    const pinch = Gesture.Pinch()
        .onStart(() => { startScale.value = scale.value; scheduleOnRN(setZoomState, true); })
        .onUpdate((event) => { scale.value = Math.max(1, Math.min(6, startScale.value * event.scale)); })
        .onFinalize(() => {
            if (scale.value <= 1.01) { scale.value = 1; x.value = withTiming(0); y.value = withTiming(0); }
            scheduleOnRN(setZoomState, scale.value > 1.01);
        });
    const tap = Gesture.Tap().maxDuration(TAP_TIMEOUT_MS).maxDistance(TAP_SLOP_PX)
        .onEnd((event, success) => {
            if (success && scale.value <= 1.01) scheduleOnRN(remoteTap, event.x, event.y);
        });
    const pan = Gesture.Pan().maxPointers(1).minDistance(TAP_SLOP_PX)
        .onStart((event) => {
            if (scale.value > 1.01) { startX.value = x.value; startY.value = y.value; return; }
            scheduleOnRN(remoteTouch, 'start', event.x - event.translationX, event.y - event.translationY);
        })
        .onUpdate((event) => {
            if (scale.value > 1.01) {
                x.value = startX.value + event.translationX;
                y.value = startY.value + event.translationY;
                return;
            }
            scheduleOnRN(remoteTouch, 'move', event.x, event.y);
        })
        .onEnd(() => { if (scale.value <= 1.01) scheduleOnRN(remoteTouch, 'end'); });
    // No double-tap: a single tap must not wait out a second-tap window.
    const zoomStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }] }));

    // Handing back is a moment inside the surface, not an alert over the
    // window: the sheet sits on the page it is about to hand over, under the
    // ownership strip that still says who is driving.
    const [handingBack, setHandingBack] = React.useState(false);
    const giveBack = React.useCallback(() => { Keyboard.dismiss(); setHandingBack(true); }, []);
    const confirmGiveBack = React.useCallback(async () => {
        setHandingBack(false);
        setDraft('');
        await takeover.giveBack();
    }, [takeover]);
    React.useEffect(() => { if (!owning) setHandingBack(false); }, [owning]);

    const commit = React.useCallback((value: string) => {
        setDraft(value);
        if (!isComposingRef.current) takeover.commit(value);
    }, [isComposingRef, takeover]);
    React.useEffect(() => {
        if (Platform.OS !== 'web' || field === null) return undefined;
        const node = composerRef.current as unknown as HTMLInputElement | null;
        if (node === null || typeof node.addEventListener !== 'function') return undefined;
        const onEnd = () => takeover.commit(node.value);
        node.addEventListener('compositionend', onEnd);
        return () => node.removeEventListener('compositionend', onEnd);
    }, [field, takeover]);
    const pasteCode = React.useCallback(async () => {
        const text = (await Clipboard.getStringAsync()).trim();
        if (text !== '') takeover.insertText(text);
    }, [takeover]);

    // ---- header -------------------------------------------------------------
    const nav = status?.navigation ?? { canGoBack: false, canGoForward: false };
    const header = (
        <View style={{ backgroundColor: theme.colors.surface, borderBottomWidth: 1, borderBottomColor: theme.colors.divider }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, minHeight: 56 }}>
                <IconButton label="Back" icon="chevron-back" disabled={!nav.canGoBack || !inputUnlocked} onPress={() => takeover.navigate('back')} />
                <IconButton label="Forward" icon="chevron-forward" disabled={!nav.canGoForward || !inputUnlocked} onPress={() => takeover.navigate('forward')} />
                <View style={{ flex: 1, minWidth: 0, paddingHorizontal: 8 }}>
                    <Text style={{ ...Typography.default('semiBold'), color: theme.colors.text }} numberOfLines={1}>{props.offer.title}</Text>
                    <Text style={{ ...Typography.default(), color: theme.colors.textSecondary, fontSize: 12 }} numberOfLines={1}>{site === '' ? 'No site yet' : site}</Text>
                </View>
                <IconButton label="Return to agent" icon="chatbubble-outline" onPress={props.onReturnToAgent} />
                <IconButton label="Close agent browser" icon="close" onPress={props.onClose} />
            </View>
            <View
                accessibilityRole="header"
                accessibilityLabel={strip.label}
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 8,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    backgroundColor: strip.tone === 'private' ? theme.colors.textLink : theme.colors.surfaceHigh,
                }}
            >
                <Ionicons name={strip.icon as never} size={18} color={strip.tone === 'private' ? '#fff' : theme.colors.text} />
                <View style={{ flex: 1, minWidth: 120 }}>
                    <Text style={{ ...Typography.default('semiBold'), color: strip.tone === 'private' ? '#fff' : theme.colors.text }}>{strip.label}</Text>
                    {isPrivate && (
                        <Text style={{ ...Typography.default(), color: '#fff', fontSize: 12, opacity: 0.9 }}>Agent input and viewing are paused</Text>
                    )}
                    {status?.reason !== undefined && !isPrivate && (
                        <Text style={{ ...Typography.default(), color: theme.colors.textSecondary, fontSize: 12 }} numberOfLines={2}>{status.reason}</Text>
                    )}
                </View>
                {snapshot.transition !== undefined && <ActivityIndicator size="small" color={strip.tone === 'private' ? '#fff' : theme.colors.text} />}
                {snapshot.transition === undefined && (state === 'agent-driving' || state === 'waiting-for-you') && (
                    <Action label="Take control" icon="hand-right-outline" emphasis onPress={() => void takeover.take()} />
                )}
                {snapshot.transition === undefined && state === 'paused' && owning && (
                    <Action label="Resume control" icon="play" onPress={() => void takeover.resume()} />
                )}
                {snapshot.transition === undefined && owning && (state === 'you-control' || state === 'paused' || state === 'taking-control') && (
                    <Action label="Give back" icon="return-down-back-outline" onPress={() => void giveBack()} />
                )}
                {snapshot.transition === undefined && (state === 'checking' || snapshot.failure !== undefined) && (
                    <Action label={snapshot.failure === undefined ? 'Retry' : `${snapshot.failure} · Retry`} icon="refresh" onPress={() => void takeover.refresh()} />
                )}
            </View>
        </View>
    );

    // ---- body ---------------------------------------------------------------
    // The video is covered whenever nothing current may show: no presented
    // frame yet (a skeleton, never an old private frame), paused, checking,
    // ended or unpaired. The cover names the state and its recovery.
    const covered = !snapshot.presented || state === 'paused' || state === 'checking' || state === 'ended' || state === 'needs-pairing' || state === 'giving-back';
    let coverBody: React.ReactNode = null;
    if (state === 'needs-pairing') {
        coverBody = <Text style={{ ...Typography.default(), color: theme.colors.textSecondary, textAlign: 'center' }}>Agent browser needs a fresh pairing. Pair this device with your computer again to continue.</Text>;
    } else if (state === 'ended') {
        coverBody = <Text style={{ ...Typography.default(), color: theme.colors.textSecondary, textAlign: 'center' }}>{status?.reason ?? 'The agent browser session ended.'}</Text>;
    } else if (state === 'paused' && owning) {
        coverBody = (
            <>
                <Ionicons name="lock-closed" size={32} color={theme.colors.textSecondary} />
                <Text style={{ ...Typography.default(), color: theme.colors.textSecondary, textAlign: 'center' }}>Your private session is paused. Resume to continue signing in, or give the browser back to the agent.</Text>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                    <Action label="Resume control" icon="play" emphasis onPress={() => void takeover.resume()} />
                    <Action label="Give back" onPress={() => void giveBack()} />
                </View>
            </>
        );
    } else if (state === 'checking' || snapshot.failure !== undefined) {
        coverBody = (
            <>
                {snapshot.failure === undefined
                    ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    : <Ionicons name="alert-circle-outline" size={32} color={theme.colors.textSecondary} />}
                <Text style={{ ...Typography.default(), color: theme.colors.textSecondary, textAlign: 'center' }}>{snapshot.failure ?? 'Checking who has control'}</Text>
            </>
        );
    } else if (covered) {
        coverBody = <View accessibilityLabel="Loading the agent browser" style={{ width: '80%', maxWidth: 480, height: '60%', borderRadius: 16, backgroundColor: theme.colors.surfaceHigh, opacity: 0.6 }} />;
    }

    const video = (
        <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, tap)}>
            <Animated.View
                style={{ flex: 1, overflow: 'hidden', backgroundColor: '#000' }}
                onLayout={(event) => setDisplay({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
            >
                <Animated.View style={[{ flex: 1 }, zoomStyle]}>
                    <HostBrowserVideo media={snapshot.media} mediaGeneration={snapshot.mediaGeneration} onPresented={onPresented} onFrame={onFrame} onWheel={onWheel} />
                </Animated.View>
                {zoomed && (
                    <View style={{ position: 'absolute', bottom: 12, alignSelf: 'center' }}>
                        <Action label="Reset zoom" icon="scan-outline" onPress={() => { scale.value = withTiming(1); x.value = withTiming(0); y.value = withTiming(0); setZoomed(false); }} />
                    </View>
                )}
            </Animated.View>
        </GestureDetector>
    );

    // ---- composer -----------------------------------------------------------
    const secret = field !== null && (field.kind === 'password' || field.kind === 'otp');
    const enterLabel = field?.enter === 'next' ? 'Next' : field?.enter === 'go' ? 'Go' : 'Enter';
    const composer = field !== null && inputUnlocked ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: theme.colors.surface, borderTopWidth: 1, borderTopColor: theme.colors.divider }}>
            <TextInput
                ref={composerRef}
                value={draft}
                onChangeText={commit}
                onSubmitEditing={() => { if (!isComposingRef.current) takeover.key('Enter'); }}
                onKeyPress={({ nativeEvent }) => { if (nativeEvent.key === 'Backspace' && draft === '') takeover.key('Backspace'); }}
                placeholder={field.label === '' ? 'Type here' : field.label}
                placeholderTextColor={theme.colors.textSecondary}
                secureTextEntry={field.kind === 'password'}
                textContentType={field.kind === 'otp' ? 'oneTimeCode' : field.kind === 'password' ? 'password' : 'none'}
                autoComplete={field.kind === 'otp' ? 'one-time-code' : field.kind === 'password' ? 'password' : 'off'}
                keyboardType={field.kind === 'otp' || field.kind === 'number' ? 'number-pad' : field.kind === 'email' ? 'email-address' : field.kind === 'tel' ? 'phone-pad' : 'default'}
                autoCapitalize="none"
                autoCorrect={!secret}
                blurOnSubmit={false}
                accessibilityLabel={field.label === '' ? 'Page text field' : field.label}
                style={{ ...Typography.default(), flex: 1, minHeight: 44, color: theme.colors.text, backgroundColor: theme.colors.surfaceHigh, borderRadius: 12, paddingHorizontal: 12 }}
            />
            {field.kind === 'otp' && <Action label="Paste code" icon="clipboard-outline" onPress={() => void pasteCode()} />}
            <Action label={enterLabel} icon="return-down-forward-outline" emphasis onPress={() => takeover.key('Enter')} />
        </View>
    ) : null;

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
            {header}
            <View style={{ flex: 1 }}>
                {video}
                {covered && (
                    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24, backgroundColor: theme.colors.surface }}>
                        {coverBody}
                    </View>
                )}
                {handingBack && (
                    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'flex-end' }}>
                        <Pressable onPress={() => setHandingBack(false)} accessibilityLabel="Keep control" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0, 0, 0, 0.35)' }} />
                        <View accessibilityViewIsModal style={{ margin: 12,  padding: 20, gap: 8, borderRadius: 16, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.divider, alignSelf: 'center', width: '100%', maxWidth: 480 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                <Ionicons name="return-down-back" size={20} color={theme.colors.text} />
                                <Text style={{ ...Typography.default('semiBold'), fontSize: 17, color: theme.colors.text }}>Give the browser back?</Text>
                            </View>
                            <Text style={{ ...Typography.default(), color: theme.colors.textSecondary }}>The agent continues from this page as it is now. What you typed stays private.</Text>
                            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 12, marginTop: 8 }}>
                                <Action label="Keep control" onPress={() => setHandingBack(false)} />
                                <Action label="Give back" icon="return-down-back" emphasis onPress={() => void confirmGiveBack()} />
                            </View>
                        </View>
                    </View>
                )}
            </View>
            {composer}
        </View>
    );
}
