import * as React from 'react';
import { ActivityIndicator, BackHandler, Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { DesktopView, useDesktopSession } from '@desklink/react-native';

import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { ui } from '@/components/ui';
import { sync } from '@/catalog';
import { useLocalSettingMutable, useMachine } from '@/catalog/store';
import { getCachedConnectionSettings } from '@/connection';
import { createDesktopSignaling } from '../application/desktopSignaling';
import { desktopCopy } from '../model/desktopCopy';
import { describeDesktopOverlay, describeInputRejection } from '../model/desktopOverlay';
import { DesktopKeyRow } from './DesktopKeyRow';

/** How long a notice stays over the desktop before it gets out of the way. */
const NOTICE_MS = 4000;

/** The first live desktop on a device explains its gestures once, for longer. */
const HINT_MS = 7000;

/** The chrome floats over the desktop: dark glass, legible over a white page. */
const GLASS = 'rgba(22,22,24,0.86)';
const GLASS_EDGE = 'rgba(255,255,255,0.14)';
const ON_GLASS = '#f4f4f5';
const ON_GLASS_MUTED = '#a1a1aa';

type DesktopPermission = 'view' | 'control' | 'clipboard';

export interface DesktopSurfaceProps {
    onExit: () => void;
}

/**
 * The live desktop, inside the conversation.
 *
 * One controller, one surface: the desktop fills the screen under a slim bar
 * that names the computer and returns to the conversation. The picture fits the
 * whole desktop and zooms with a pinch; the rest of the chrome is what a phone
 * cannot do with the desktop's own keyboard — the native keyboard and the keys
 * it lacks, and the two explicit clipboard directions.
 */
export function DesktopSurface({ onExit }: DesktopSurfaceProps) {
    const { theme } = useUnistyles();
    const [clipboardBusy, setClipboardBusy] = React.useState(false);
    const [notice, setNotice] = React.useState<{ text: string; ms: number } | null>(null);
    const [keyboardOpen, setKeyboardOpen] = React.useState(false);
    const [clipboardAvailable, setClipboardAvailable] = React.useState(false);
    const [clipboardOpen, setClipboardOpen] = React.useState(false);
    const [landscape, setLandscape] = React.useState(false);
    const keyboard = useKeyboardState();
    const insets = useSafeAreaInsets();
    const { height: windowHeight } = useWindowDimensions();
    const [openedBefore, setOpenedBefore] = useLocalSettingMutable('desktopOpenedBefore');
    const machine = useMachine(getCachedConnectionSettings().machineId ?? '');
    const computerName = machine?.metadata?.displayName || machine?.metadata?.host || 'Computer';

    const say = React.useCallback((text: string, ms = NOTICE_MS) => setNotice({ text, ms }), []);

    const session = useDesktopSession({
        // Ask the host what it can actually do before requesting scope: a host
        // whose clipboard backend is absent must not be asked for a permission
        // whose every use would fail. The picture's size and rate are the
        // engine's to choose: the desktop's own pixels, so zooming stays sharp.
        authorize: React.useCallback(async () => {
            const capabilities = await sync.request('desktop.capabilities', {}).catch(() => null);
            const canClipboard = capabilities?.clipboard === true;
            setClipboardAvailable(canClipboard);
            const permissions: DesktopPermission[] = canClipboard
                ? ['view', 'control', 'clipboard']
                : ['view', 'control'];
            return {
                signaling: createDesktopSignaling({ permissions }),
                session: { permissions },
            };
        }, []),
        onError: (failure) => say(failure.message),
        // Text the desktop refused is a notice, not a failure: the session
        // carries on, and the clipboard is the way round.
        onRejected: ({ code }) => {
            const message = describeInputRejection(code, clipboardAvailable);
            if (message !== null) say(message);
        },
    });

    const { connect, close, snapshot, releaseHeld, hideKeyboard, setOrientation } = session;

    // Opening is a user action: this screen is on screen because the user asked
    // for the desktop, and the host still has to consent to the capture.
    React.useEffect(() => {
        void connect();
        return () => {
            releaseHeld();
            hideKeyboard();
            setOrientation('auto');
            void close('left the desktop');
        };
    }, [connect, close, releaseHeld, hideKeyboard, setOrientation]);

    React.useEffect(() => setKeyboardOpen(keyboard.isVisible), [keyboard.isVisible]);

    React.useEffect(() => {
        if (notice === null) return;
        const timer = setTimeout(() => setNotice(null), notice.ms);
        return () => clearTimeout(timer);
    }, [notice]);

    const toggleKeyboard = React.useCallback(() => {
        setClipboardOpen(false);
        if (keyboardOpen) {
            session.hideKeyboard();
            setKeyboardOpen(false);
            return;
        }
        session.showKeyboard();
        setKeyboardOpen(true);
    }, [keyboardOpen, session]);

    const toggleLandscape = React.useCallback(() => {
        const next = !landscape;
        setLandscape(next);
        setOrientation(next ? 'landscape' : 'auto');
    }, [landscape, setOrientation]);

    const copyFromDesktop = React.useCallback(async () => {
        setClipboardBusy(true);
        setNotice(null);
        try {
            const { text, truncated } = await session.copyRemoteToLocal();
            await Clipboard.setStringAsync(text);
            if (truncated) say('Copied the start of the desktop clipboard; the rest was too large.');
            else if (text === '') say('The desktop clipboard was empty.');
            else say('Copied to this phone.');
        } catch (error) {
            say(error instanceof Error ? error.message : 'Could not copy from the desktop.');
        } finally {
            setClipboardBusy(false);
        }
    }, [session, say]);

    const pasteToDesktop = React.useCallback(async () => {
        setClipboardBusy(true);
        setNotice(null);
        try {
            const text = await Clipboard.getStringAsync();
            await session.pasteLocalToRemote(text);
            say('On the desktop clipboard. Hold on a field and choose Paste.');
        } catch (error) {
            say(error instanceof Error ? error.message : 'Could not paste to the desktop.');
        } finally {
            setClipboardBusy(false);
        }
    }, [session, say]);

    React.useEffect(() => {
        if (Platform.OS !== 'android') return;
        const back = BackHandler.addEventListener('hardwareBackPress', () => {
            if (clipboardOpen) setClipboardOpen(false);
            else onExit();
            return true;
        });
        return () => back.remove();
    }, [clipboardOpen, onExit]);

    const live = snapshot.status === 'live';
    // The screen-sharing approval happens on the computer, and only the first
    // time; once a desktop has been live here, the start stops pointing at it.
    // The first live desktop also says, once, how to move around it.
    React.useEffect(() => {
        if (!live || openedBefore) return;
        setOpenedBefore(true);
        say(desktopCopy.gestureHint, HINT_MS);
    }, [live, openedBefore, setOpenedBefore, say]);

    const status = describeDesktopOverlay(snapshot, openedBefore);
    const clipboardUnavailable = live && !clipboardAvailable;
    const shownNotice = live ? notice?.text ?? (clipboardUnavailable ? desktopCopy.clipboardUnavailable : null) : null;
    const keyRowShown = live && keyboardOpen;
    // A short screen with the keyboard up (a phone on its side) keeps what
    // height it has for the desktop; the bar comes back with the keyboard down.
    const barShown = !(keyboard.isVisible && windowHeight < 480);
    const dockBottom = keyboard.isVisible ? 10 : Math.max(insets.bottom, 8) + 10;
    const statusLabel = live ? desktopCopy.liveLabel : snapshot.status === 'reconnecting' ? desktopCopy.reconnectingTitle : status.spinner ? desktopCopy.connectingLabel : null;

    return (
        <View style={styles.screen}>
            {barShown && <View style={styles.bar}>
                <Pressable onPress={onExit} accessibilityRole="button" accessibilityLabel="Back to the conversation" hitSlop={10} style={({ pressed }) => [styles.barButton, pressed && styles.pressed]}>
                    <Ionicons name="arrow-back" size={20} color={ON_GLASS} />
                </Pressable>
                <View style={styles.title} accessible accessibilityRole="header" accessibilityLabel={`${computerName}${statusLabel === null ? '' : `, ${statusLabel}`}`}>
                    <Ionicons name="desktop-outline" size={15} color={ON_GLASS_MUTED} />
                    <Text numberOfLines={1} style={styles.titleText}>{computerName}</Text>
                    {statusLabel !== null && (
                        <View style={styles.status}>
                            <View style={[styles.statusDot, { backgroundColor: live ? '#34d399' : ON_GLASS_MUTED }]} />
                            <Text numberOfLines={1} style={styles.statusText}>{statusLabel}</Text>
                        </View>
                    )}
                </View>
                {live && (
                    <Pressable onPress={session.fitToView} accessibilityRole="button" accessibilityLabel="Show the whole desktop" hitSlop={6} style={({ pressed }) => [styles.barButton, pressed && styles.pressed]}>
                        <Ionicons name="scan-outline" size={19} color={ON_GLASS} />
                    </Pressable>
                )}
                {live && Platform.OS === 'android' && (
                    <Pressable onPress={toggleLandscape} accessibilityRole="button" accessibilityLabel={landscape ? 'Follow the phone\'s rotation' : 'Turn to landscape'} accessibilityState={{ selected: landscape }} hitSlop={6} style={({ pressed }) => [styles.barButton, landscape && styles.barButtonOn, pressed && styles.pressed]}>
                        <Ionicons name={landscape ? 'phone-portrait-outline' : 'phone-landscape-outline'} size={19} color={ON_GLASS} />
                    </Pressable>
                )}
            </View>}

            <View style={styles.body}>
                <DesktopView sessionId={session.nativeId} style={styles.surface} accessibilityLabel={`${computerName} desktop`} />
                {!live && (
                    <View style={styles.overlay}>
                        {status.spinner && <ActivityIndicator size="small" color={theme.colors.textSecondary} />}
                        <Text style={[styles.overlayTitle, { color: theme.colors.text }]}>{status.title}</Text>
                        {status.detail !== undefined && (
                            <Text style={[styles.overlayDetail, { color: theme.colors.textSecondary }]}>{status.detail}</Text>
                        )}
                        {status.canRetry && (
                            <Pressable
                                onPress={() => void connect()}
                                accessibilityRole="button"
                                accessibilityLabel="Try again"
                                style={[styles.action, { backgroundColor: theme.colors.button.primary.background }]}
                            >
                                <Text style={[styles.actionLabel, { color: theme.colors.button.primary.tint }]}>Try again</Text>
                            </Pressable>
                        )}
                    </View>
                )}

                {live && <>
                    {clipboardOpen && <>
                        <Pressable style={StyleSheet.absoluteFill} onPress={() => setClipboardOpen(false)} accessibilityLabel="Close clipboard options" />
                        <View style={[styles.clipboardCard, { bottom: dockBottom + 58 }]}>
                            <Pressable onPress={() => { setClipboardOpen(false); void copyFromDesktop(); }} disabled={clipboardBusy || !clipboardAvailable} accessibilityRole="button" accessibilityLabel="Copy to Phone" style={({ pressed }) => [styles.clipboardRow, pressed && styles.rowPressed]}>
                                <Ionicons name="phone-portrait-outline" size={20} color={ON_GLASS_MUTED} />
                                <View style={styles.clipboardText}>
                                    <Text style={styles.clipboardLabel}>Copy to Phone</Text>
                                    <Text style={styles.clipboardDetail}>What the desktop last copied</Text>
                                </View>
                            </Pressable>
                            <View style={styles.clipboardDivider} />
                            <Pressable onPress={() => { setClipboardOpen(false); void pasteToDesktop(); }} disabled={clipboardBusy || !clipboardAvailable} accessibilityRole="button" accessibilityLabel="Paste from Phone" style={({ pressed }) => [styles.clipboardRow, pressed && styles.rowPressed]}>
                                <Ionicons name="desktop-outline" size={20} color={ON_GLASS_MUTED} />
                                <View style={styles.clipboardText}>
                                    <Text style={styles.clipboardLabel}>Paste from Phone</Text>
                                    <Text style={styles.clipboardDetail}>Put this phone's text on the desktop clipboard</Text>
                                </View>
                            </Pressable>
                        </View>
                    </>}

                    {shownNotice !== null && (
                        <View pointerEvents="none" style={[styles.notice, { bottom: dockBottom + 60 }]}>
                            <Text accessibilityLiveRegion="polite" numberOfLines={3} style={styles.noticeText}>{shownNotice}</Text>
                        </View>
                    )}

                    <View style={[styles.dock, { bottom: dockBottom }]}>
                        <Pressable onPress={toggleKeyboard} accessibilityRole="button" accessibilityLabel="Keyboard" accessibilityState={{ selected: keyboardOpen }} style={({ pressed }) => [styles.dockButton, keyboardOpen && styles.dockButtonOn, pressed && styles.pressed]}>
                            <Ionicons name={keyboardOpen ? 'keypad' : 'keypad-outline'} size={21} color={ON_GLASS} />
                        </Pressable>
                        <View style={styles.dockDivider} />
                        <Pressable onPress={() => setClipboardOpen((open) => !open)} disabled={!clipboardAvailable} accessibilityRole="button" accessibilityLabel="Clipboard" accessibilityState={{ disabled: !clipboardAvailable, expanded: clipboardOpen, busy: clipboardBusy }} style={({ pressed }) => [styles.dockButton, clipboardOpen && styles.dockButtonOn, !clipboardAvailable && styles.disabled, pressed && styles.pressed]}>
                            {clipboardBusy
                                ? <ActivityIndicator size="small" color={ON_GLASS} />
                                : <Ionicons name="clipboard-outline" size={21} color={ON_GLASS} />}
                        </Pressable>
                    </View>
                </>}
            </View>

            {keyRowShown && (
                <View style={[styles.keyRow, { paddingBottom: keyboard.isVisible ? 0 : insets.bottom }]}>
                    <DesktopKeyRow session={session} />
                </View>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    // `flex: 1` alone collapses to nothing inside a web route that has no
    // sized ancestor; the explicit percentage is what gives the live surface a
    // box on both platforms.
    screen: { flex: 1, width: '100%', height: '100%', backgroundColor: '#000' },
    bar: {
        height: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        paddingHorizontal: 6,
        backgroundColor: '#0b0b0c',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: GLASS_EDGE,
    },
    barButton: { width: 40, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
    barButtonOn: { backgroundColor: 'rgba(255,255,255,0.12)' },
    title: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4 },
    titleText: { ...Typography.default('semiBold'), flexShrink: 1, color: ON_GLASS, fontSize: 15 },
    status: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 },
    statusDot: { width: 6, height: 6, borderRadius: 3 },
    statusText: { ...Typography.default(), color: ON_GLASS_MUTED, fontSize: 12 },
    body: { flex: 1, minHeight: 0 },
    surface: { flex: 1 },
    overlay: {
        backgroundColor: '#000',
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        paddingHorizontal: 32,
    },
    overlayTitle: { ...Typography.default('semiBold'), fontSize: 16, lineHeight: 22, textAlign: 'center' },
    overlayDetail: { ...Typography.default(), fontSize: 14, lineHeight: 20, textAlign: 'center' },
    action: {
        marginTop: 6,
        height: 44,
        minWidth: 140,
        paddingHorizontal: 20,
        borderRadius: ui.radius.control,
        alignItems: 'center',
        justifyContent: 'center',
    },
    actionLabel: { ...Typography.default('semiBold'), fontSize: 14 },
    notice: {
        position: 'absolute',
        alignSelf: 'center',
        maxWidth: '88%',
        paddingHorizontal: 14,
        paddingVertical: 9,
        borderRadius: 14,
        backgroundColor: GLASS,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: GLASS_EDGE,
    },
    noticeText: { ...Typography.default(), color: ON_GLASS, fontSize: 13, lineHeight: 18, textAlign: 'center' },
    dock: {
        position: 'absolute',
        alignSelf: 'center',
        flexDirection: 'row',
        alignItems: 'center',
        padding: 4,
        borderRadius: 26,
        backgroundColor: GLASS,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: GLASS_EDGE,
        shadowColor: '#000',
        shadowOpacity: 0.35,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 8,
    },
    dockButton: { width: 48, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
    dockButtonOn: { backgroundColor: 'rgba(255,255,255,0.16)' },
    dockDivider: { width: StyleSheet.hairlineWidth, height: 22, backgroundColor: GLASS_EDGE, marginHorizontal: 2 },
    clipboardCard: {
        position: 'absolute',
        alignSelf: 'center',
        width: 290,
        maxWidth: '92%',
        borderRadius: 18,
        paddingVertical: 4,
        backgroundColor: GLASS,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: GLASS_EDGE,
        zIndex: 3,
    },
    clipboardRow: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 8 },
    rowPressed: { backgroundColor: 'rgba(255,255,255,0.08)' },
    clipboardText: { flex: 1, minWidth: 0 },
    clipboardLabel: { ...Typography.default('semiBold'), color: ON_GLASS, fontSize: 15 },
    clipboardDetail: { ...Typography.default(), color: ON_GLASS_MUTED, fontSize: 12, marginTop: 1 },
    clipboardDivider: { height: StyleSheet.hairlineWidth, marginHorizontal: 16, backgroundColor: GLASS_EDGE },
    keyRow: { backgroundColor: '#0b0b0c', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: GLASS_EDGE },
    pressed: { opacity: 0.6 },
    disabled: { opacity: 0.4 },
});
