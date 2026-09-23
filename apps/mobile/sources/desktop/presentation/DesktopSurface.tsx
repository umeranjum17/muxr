import * as React from 'react';
import { ActivityIndicator, BackHandler, Dimensions, Platform, Pressable, StyleSheet, useWindowDimensions, View, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion, useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { useKeyboardState, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { DesktopView, observeWebKeyboardMotion, useDesktopSession } from '@desklink/react-native';

import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { ui } from '@/components/ui';
import { sync } from '@/catalog';
import { useLocalSettingMutable, useMachine } from '@/catalog/store';
import { getCachedConnectionSettings } from '@/connection';
import { createDesktopSignaling } from '../application/desktopSignaling';
import { desktopCopy } from '../model/desktopCopy';
import { describeDesktopOverlay, describeInputRejection } from '../model/desktopOverlay';
import { DESKTOP_KEY_ROW_HEIGHT, DesktopKeyRow } from './DesktopKeyRow';

/** Request smoother motion than the engine's default; still frames are not repeated. */
const DESKTOP_FPS = 60;

/** How long a notice stays over the desktop before it gets out of the way. */
const NOTICE_MS = 4000;

/** The first live desktop on a device explains its gestures once, for longer. */
const HINT_MS = 7000;

/** The two round controls: a thumb's size, in the terminal's floating material. */
const BUTTON = 44;
/** From the screen's sides. */
const EDGE = 16;
/** Above the home indicator while the keyboard is down. */
const REST_GAP = 12;
/** Between the round controls and the key row riding on the keyboard. */
const ABOVE_KEYS = 8;
/** Between the picture and the round controls while the keyboard is up. */
const PICTURE_GAP = 8;

type DesktopPermission = 'view' | 'control' | 'clipboard';
type Menu = 'clipboard' | 'help' | 'more';

/** What each gesture does, for the help the header's "?" opens. */
const GESTURES: readonly [gesture: string, effect: string][] = [
    ['Tap', 'Click'],
    ['Double-tap', 'Double-click'],
    ['Hold', 'Right-click'],
    ['Hold and drag', 'Select or drag'],
    ['Two fingers', 'Scroll'],
    ['Pinch', 'Zoom'],
    ['Drag', 'Move around when zoomed'],
    ['Drag on the whole desktop', 'Move the pointer'],
];

/**
 * A browser that refuses the phone's clipboard explains in its own words, which
 * read like a verdict ("User denied permission"). It is usually the first try,
 * before or while the site is allowed, so say what to do instead.
 */
function describeClipboardError(error: unknown, fallback: string): string {
    const refused = error as { code?: unknown } | null;
    if (refused?.code === 'ERR_NO_PERMISSION') return desktopCopy.clipboardBlocked;
    return error instanceof Error ? error.message : fallback;
}

export interface DesktopSurfaceProps {
    onExit: () => void;
    /** The conversation the desktop was opened from; the computer's name without one. */
    title?: string;
    /** The conversation's mark, drawn before the title the way its own header draws it. */
    leading?: React.ReactNode;
}

/**
 * The keyboard's offset (negative while it is up) and how far up it is, as
 * values the UI thread moves with it. A phone browser reports neither: there
 * the visual viewport says how much of the page the keyboard covers.
 */
function useKeyboardMotion(): { height: SharedValue<number>; progress: SharedValue<number>; visible: boolean } {
    const native = useReanimatedKeyboardAnimation();
    const height = useSharedValue(0);
    const progress = useSharedValue(0);
    const [visible, setVisible] = React.useState(false);
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        return observeWebKeyboardMotion(({ covered, phase }) => {
            height.value = -covered;
            progress.value = phase;
            setVisible(covered > 0);
        });
    }, [height, progress]);
    return Platform.OS === 'web' ? { height, progress, visible } : { ...native, visible: false };
}

/**
 * The live desktop, inside the conversation.
 *
 * The screen is the desktop: fitted to the width on black, under the
 * conversation's own header line. Two round controls float in the bottom
 * corners, for what a phone cannot do with the desktop's own hands — the
 * clipboard, both ways, and the keyboard. With the keyboard up, the key row a
 * phone keyboard lacks rides on it, the controls above that, and the picture
 * moves up to sit over all of them with the pointer still in sight.
 */
export function DesktopSurface({ onExit, title, leading }: DesktopSurfaceProps) {
    const { theme } = useUnistyles();
    const [clipboardBusy, setClipboardBusy] = React.useState(false);
    const [notice, setNotice] = React.useState<{ text: string; ms: number } | null>(null);
    const [keyboardOpen, setKeyboardOpen] = React.useState(false);
    const [clipboardAvailable, setClipboardAvailable] = React.useState(false);
    const [menu, setMenu] = React.useState<Menu | null>(null);
    const [landscape, setLandscape] = React.useState(false);
    const keyboard = useKeyboardState();
    const motion = useKeyboardMotion();
    const insets = useSafeAreaInsets();
    const { width: windowWidth } = useWindowDimensions();
    const [openedBefore, setOpenedBefore] = useLocalSettingMutable('desktopOpenedBefore');
    const machine = useMachine(getCachedConnectionSettings().machineId ?? '');
    const computerName = machine?.metadata?.displayName || machine?.metadata?.host || 'Computer';
    const heading = title || computerName;

    const say = React.useCallback((text: string, ms = NOTICE_MS) => setNotice({ text, ms }), []);
    const [commandCopied, setCommandCopied] = React.useState(false);
    const copyCommand = React.useCallback(async (command: string) => {
        await Clipboard.setStringAsync(command);
        setCommandCopied(true);
        setTimeout(() => setCommandCopied(false), 2000);
    }, []);

    const session = useDesktopSession({
        // Ask the host what it can actually do before requesting scope: a host
        // whose clipboard backend is absent must not be asked for a permission
        // whose every use would fail. The picture's size is the engine's to
        // choose: the desktop's own pixels, so zooming stays sharp.
        authorize: React.useCallback(async () => {
            const capabilities = await sync.request('desktop.capabilities', {}).catch(() => null);
            const canClipboard = capabilities?.clipboard === true;
            setClipboardAvailable(canClipboard);
            const permissions: DesktopPermission[] = canClipboard
                ? ['view', 'control', 'clipboard']
                : ['view', 'control'];
            return {
                signaling: createDesktopSignaling({ permissions, maxFps: DESKTOP_FPS }),
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
        const timer = setTimeout(() => {
            setNotice(notice.text === desktopCopy.gestureHint && !clipboardAvailable
                ? { text: desktopCopy.clipboardUnavailable, ms: NOTICE_MS }
                : null);
        }, notice.ms);
        return () => clearTimeout(timer);
    }, [notice, clipboardAvailable]);

    const toggleKeyboard = React.useCallback(() => {
        setMenu(null);
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
            const remote = session.copyRemoteToLocal();
            let written: Promise<boolean> | undefined;
            if (Platform.OS === 'web') {
                try {
                    const write = typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write
                        ? navigator.clipboard.write([new ClipboardItem({ 'text/plain': remote.then(({ text }) => new Blob([text], { type: 'text/plain' })) })])
                        : remote.then(({ text }) => navigator.clipboard.writeText(text));
                    written = write.then(() => true, () => false);
                } catch {
                    written = Promise.resolve(false);
                }
            }
            const { text, truncated } = await remote;
            if (written !== undefined) {
                if (!await written) throw new Error(desktopCopy.clipboardBlocked);
            } else {
                await Clipboard.setStringAsync(text);
            }
            if (truncated) say('Copied the start of the desktop clipboard; the rest was too large.');
            else if (text === '') say('The desktop clipboard was empty.');
            else say('Copied to this phone.');
        } catch (error) {
            say(describeClipboardError(error, 'Could not copy from the desktop.'));
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
            say(describeClipboardError(error, 'Could not paste to the desktop.'));
        } finally {
            setClipboardBusy(false);
        }
    }, [session, say]);

    React.useEffect(() => {
        if (Platform.OS !== 'android') return;
        const back = BackHandler.addEventListener('hardwareBackPress', () => {
            if (menu !== null) setMenu(null);
            else onExit();
            return true;
        });
        return () => back.remove();
    }, [menu, onExit]);

    const live = snapshot.status === 'live';
    // The first desktop on a device explains its gestures; after that, a
    // computer that cannot share its clipboard says so once per opening
    // rather than for as long as the desktop is up.
    const explained = React.useRef(false);
    React.useEffect(() => {
        if (!live || explained.current) return;
        explained.current = true;
        if (!openedBefore) {
            setOpenedBefore(true);
            say(desktopCopy.gestureHint, HINT_MS);
        } else if (!clipboardAvailable) {
            say(desktopCopy.clipboardUnavailable);
        }
    }, [live, openedBefore, setOpenedBefore, clipboardAvailable, say]);

    const status = describeDesktopOverlay(snapshot, openedBefore);
    const shownNotice = live ? notice?.text ?? null : null;
    // The row stays while the keyboard is still on its way down, fading with it.
    const web = Platform.OS === 'web';
    const keyRowShown = live && (keyboardOpen || keyboard.isVisible || (web && motion.visible));
    // A phone on its side has little height once the keyboard is up: the
    // header steps aside, and the round controls sit at the ends of the key
    // row instead of above it.
    const screen = Dimensions.get('screen');
    const compact = screen.width > screen.height;
    const compactKeyboard = compact && (keyboard.isVisible || (web && motion.visible));
    const headerShown = !compactKeyboard;
    const popupReady = !keyboard.isVisible && !(web && motion.visible);
    const rise = compact ? (DESKTOP_KEY_ROW_HEIGHT - BUTTON) / 2 : DESKTOP_KEY_ROW_HEIGHT + ABOVE_KEYS;
    const clearance = compact ? (DESKTOP_KEY_ROW_HEIGHT + BUTTON) / 2 + PICTURE_GAP / 2 : rise + BUTTON + PICTURE_GAP;
    const statusLabel = live ? desktopCopy.liveLabel : snapshot.status === 'reconnecting' ? desktopCopy.reconnectingTitle : status.spinner ? desktopCopy.connectingLabel : null;

    // The key row rides on the keyboard and fades in as it rises; the
    // controls rise over it by the same measure, so the keyboard, the row,
    // the controls and the picture arrive as one movement. The keyboard's
    // height already covers the home indicator, so the inset that lifts them
    // at rest is let go as the keyboard comes up.
    const { height: keyboardOffset, progress: keyboardShown } = motion;
    const [noOverlapReady, setNoOverlapReady] = React.useState(false);
    React.useEffect(() => {
        setNoOverlapReady(false);
        if (!web || motion.visible || !(keyboardOpen || keyboard.isVisible)) return;
        // Wait for the phone's viewport to move before treating focus as a hardware keyboard.
        const timer = setTimeout(() => setNoOverlapReady(true), 180);
        return () => clearTimeout(timer);
    }, [web, motion.visible, keyboardOpen, keyboard.isVisible]);
    const noOverlapKeys = web && !motion.visible && (keyboardOpen || keyboard.isVisible) && noOverlapReady;
    const bottomInset = insets.bottom;
    const keyRowMotion = useAnimatedStyle(() => {
        const shown = noOverlapKeys ? 1 : keyboardShown.value;
        return {
            opacity: shown,
            transform: [{ translateY: keyboardOffset.value + bottomInset * shown }],
        };
    });
    const controlsMotion = useAnimatedStyle(() => {
        const shown = noOverlapKeys ? 1 : keyboardShown.value;
        return {
            transform: [{ translateY: keyboardOffset.value + bottomInset * shown - shown * (rise - REST_GAP) }],
        };
    });

    const control = (pressed: boolean, on = false): ViewStyle => ({
        width: BUTTON,
        height: BUTTON,
        borderRadius: BUTTON / 2,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        backgroundColor: pressed || on ? theme.colors.terminalChrome.clusterPressed : theme.colors.terminalChrome.cluster,
    });
    const card: ViewStyle = {
        position: 'absolute',
        borderRadius: 20,
        paddingVertical: 6,
        backgroundColor: theme.colors.surfaceHighest,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        shadowColor: '#000',
        shadowOpacity: 0.4,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 6 },
        elevation: 12,
        zIndex: 3,
    };
    const toggleMenu = (target: 'more' | 'help') => {
        if (menu !== target && (keyboardOpen || keyboard.isVisible || motion.visible)) {
            session.hideKeyboard();
            setKeyboardOpen(false);
        }
        setMenu((open) => (open === target ? null : target));
    };
    const menuRow = (label: string, icon: React.ComponentProps<typeof Ionicons>['name'], onPress: () => void, options: { selected?: boolean; disabled?: boolean } = {}) => (
        <Pressable
            key={label}
            onPress={() => { setMenu(null); onPress(); }}
            disabled={options.disabled}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ selected: options.selected, disabled: options.disabled }}
            style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: theme.colors.surfacePressed }, options.disabled && styles.disabled]}
        >
            <Ionicons name={icon} size={18} color={theme.colors.textSecondary} />
            <Text style={[styles.menuLabel, { color: theme.colors.text }]}>{label}</Text>
            {options.selected === true && <Ionicons name="checkmark" size={17} color={theme.colors.text} />}
        </Pressable>
    );
    const headerMark = ({ pressed }: { pressed: boolean }) => [styles.headerButton, pressed && styles.pressed];
    const popIn = FadeIn.duration(140).reduceMotion(ReduceMotion.System);
    const popOut = FadeOut.duration(100).reduceMotion(ReduceMotion.System);

    return (
        <View style={styles.screen}>
            {/* The conversation's own header line, so opening the desktop
                changes what is under it and nothing above: back, the
                conversation, help, and the less-used actions. */}
            {headerShown && <View style={styles.header}>
                <Pressable onPress={onExit} accessibilityRole="button" accessibilityLabel="Back to the conversation" hitSlop={12} style={headerMark}>
                    <Ionicons name="arrow-back" size={18} color={theme.colors.text} />
                </Pressable>
                <View style={styles.title} accessible accessibilityRole="header" accessibilityLabel={`${heading}${statusLabel === null ? '' : `, desktop ${statusLabel.toLowerCase()}`}`}>
                    {leading ?? <Ionicons name="desktop-outline" size={14} color={theme.colors.textSecondary} />}
                    <Text numberOfLines={1} style={[styles.titleText, { color: theme.colors.text }]}>{heading}</Text>
                </View>
                <Pressable onPress={() => toggleMenu('help')} accessibilityRole="button" accessibilityLabel="Desktop gestures" accessibilityState={{ expanded: menu === 'help' }} hitSlop={8} style={headerMark}>
                    <Ionicons name="help-circle-outline" size={19} color={theme.colors.text} />
                </Pressable>
                <Animated.View entering={popIn}>
                    <Pressable onPress={() => toggleMenu('more')} accessibilityRole="button" accessibilityLabel="Desktop actions" accessibilityState={{ expanded: menu === 'more' }} hitSlop={8} style={headerMark}>
                        <Ionicons name="ellipsis-vertical" size={18} color={theme.colors.text} />
                    </Pressable>
                </Animated.View>
            </View>}

            <View style={styles.body}>
                <DesktopView sessionId={session.nativeId} style={styles.surface} accessibilityLabel={`${computerName} desktop`} keyboardClearance={clearance} />

                {/* The start is quiet — a small spinner and one line on the
                    surface's own black — and it fades as the first picture
                    comes up out of that black beneath it. It has no fill of
                    its own: a fill over a video surface hides the picture
                    until the fill is gone, which reads as a cut. */}
                {!live && (
                    <Animated.View exiting={FadeOut.duration(250).reduceMotion(ReduceMotion.System)} style={styles.overlay}>
                        {status.spinner && <ActivityIndicator size="small" color={theme.colors.textSecondary} />}
                        <Text style={[styles.overlayTitle, { color: theme.colors.text }]}>{status.title}</Text>
                        {status.detail !== undefined && (
                            <Text style={[styles.overlayDetail, { color: theme.colors.textSecondary }]}>{status.detail}</Text>
                        )}
                        {status.command !== undefined && (
                            <Pressable
                                onPress={() => void copyCommand(status.command!)}
                                accessibilityRole="button"
                                accessibilityLabel={commandCopied ? 'Copied' : 'Copy the command'}
                                style={({ pressed }) => [styles.command, { backgroundColor: theme.colors.surfaceHighest, borderColor: theme.colors.glass.border }, pressed && styles.pressed]}
                            >
                                <Text numberOfLines={3} style={[styles.commandText, { color: theme.colors.text }]}>{status.command}</Text>
                                <Text style={[styles.commandCopy, { color: theme.colors.textSecondary }]}>{commandCopied ? 'Copied' : 'Copy'}</Text>
                            </Pressable>
                        )}
                        {status.canRetry && (
                            <Pressable
                                onPress={() => void connect()}
                                accessibilityRole="button"
                                accessibilityLabel="Try again"
                                style={({ pressed }) => [styles.action, { backgroundColor: theme.colors.button.primary.background }, pressed && styles.pressed]}
                            >
                                <Text style={[styles.actionLabel, { color: theme.colors.button.primary.tint }]}>Try again</Text>
                            </Pressable>
                        )}
                    </Animated.View>
                )}

                {compactKeyboard && (
                    <View pointerEvents="box-none" style={styles.compactHeader}>
                        <Pressable onPress={onExit} accessibilityRole="button" accessibilityLabel="Back to the conversation" style={({ pressed }) => control(pressed)}>
                            <Ionicons name="arrow-back" size={18} color={theme.colors.text} />
                        </Pressable>
                        <Pressable onPress={() => toggleMenu('more')} accessibilityRole="button" accessibilityLabel="Desktop actions" accessibilityState={{ expanded: menu === 'more' }} style={({ pressed }) => control(pressed, menu === 'more')}>
                            <Ionicons name="ellipsis-vertical" size={18} color={theme.colors.text} />
                        </Pressable>
                    </View>
                )}

                {menu !== null && <Pressable style={StyleSheet.absoluteFill} onPress={() => setMenu(null)} accessibilityLabel="Close menu" />}

                {menu === 'help' && popupReady && (
                    <Animated.View entering={popIn} exiting={popOut} style={[card, styles.topCard, { width: Math.min(windowWidth - 16, 320) }]}>
                        {GESTURES.map(([gesture, effect]) => (
                            <View key={gesture} style={[styles.helpRow, compact && styles.compactHelpRow]} accessible accessibilityLabel={`${gesture}: ${effect}`}>
                                <Text style={[styles.helpGesture, { color: theme.colors.textSecondary }]}>{gesture}</Text>
                                <Text style={[styles.helpEffect, { color: theme.colors.text }]}>{effect}</Text>
                            </View>
                        ))}
                    </Animated.View>
                )}

                {menu === 'more' && popupReady && (
                    <Animated.View entering={popIn} exiting={popOut} style={[card, styles.topCard]}>
                        {menuRow('Gestures', 'help-circle-outline', () => toggleMenu('help'))}
                        {live && menuRow('Fit to screen', 'scan-outline', session.fitToView)}
                        {live && Platform.OS === 'android' && menuRow('Landscape', 'phone-landscape-outline', toggleLandscape, { selected: landscape })}
                        {menuRow('Disconnect', 'power-outline', onExit)}
                    </Animated.View>
                )}

                {keyRowShown && (
                    // Untouchable until the keyboard has brought it up: a row
                    // still waiting at the bottom would take the desktop's taps.
                    <Animated.View pointerEvents={web ? (motion.visible || noOverlapKeys ? 'auto' : 'none') : (keyboard.isVisible ? 'auto' : 'none')} style={[styles.keyRow, { bottom: bottomInset, paddingHorizontal: compact ? EDGE + BUTTON + 4 : 0 }, keyRowMotion]}>
                        <DesktopKeyRow session={session} />
                    </Animated.View>
                )}

                {live && menu === 'clipboard' && clipboardAvailable && (
                    <Animated.View entering={popIn} exiting={popOut} style={[card, styles.clipboardCard, { bottom: bottomInset + REST_GAP + BUTTON + 10 }, controlsMotion]}>
                        {menuRow('Copy to Phone', 'copy-outline', () => void copyFromDesktop(), { disabled: clipboardBusy })}
                        {menuRow('Paste from Phone', 'clipboard-outline', () => void pasteToDesktop(), { disabled: clipboardBusy })}
                    </Animated.View>
                )}

                {live && (
                    <Animated.View pointerEvents="box-none" style={[styles.controls, { bottom: bottomInset + REST_GAP }, controlsMotion]}>
                        {shownNotice !== null && (
                            <View pointerEvents="none" style={styles.noticeLane}>
                                <View style={[styles.notice, { backgroundColor: theme.colors.surfaceHighest, borderColor: theme.colors.glass.border }]}>
                                    <Text accessibilityLiveRegion="polite" numberOfLines={3} style={[styles.noticeText, { color: theme.colors.text }]}>{shownNotice}</Text>
                                </View>
                            </View>
                        )}

                        {clipboardAvailable ? (
                            <Pressable onPress={() => setMenu((open) => (open === 'clipboard' ? null : 'clipboard'))} accessibilityRole="button" accessibilityLabel="Clipboard" accessibilityState={{ expanded: menu === 'clipboard', busy: clipboardBusy }} style={({ pressed }) => control(pressed, menu === 'clipboard')}>
                                {clipboardBusy
                                    ? <ActivityIndicator size="small" color={theme.colors.text} />
                                    : <Ionicons name="clipboard-outline" size={20} color={theme.colors.text} />}
                            </Pressable>
                        ) : <View />}
                        <Pressable onPress={toggleKeyboard} accessibilityRole="button" accessibilityLabel={keyboardOpen ? 'Hide keyboard' : 'Keyboard'} accessibilityState={{ selected: keyboardOpen }} style={({ pressed }) => control(pressed, keyboardOpen)}>
                            <MaterialCommunityIcons name={keyboardOpen ? 'keyboard-close-outline' : 'keyboard-outline'} size={21} color={theme.colors.text} />
                        </Pressable>
                    </Animated.View>
                )}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    // `flex: 1` alone collapses to nothing inside a web route that has no
    // sized ancestor; the explicit percentage is what gives the live surface a
    // box on both platforms.
    screen: { flex: 1, width: '100%', height: '100%', backgroundColor: '#000' },
    header: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 6, minHeight: 32, backgroundColor: '#000' },
    headerButton: { minWidth: 32, minHeight: 30, alignItems: 'center', justifyContent: 'center' },
    title: { flex: 1, minWidth: 0, minHeight: 30, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 3 },
    titleText: { flexShrink: 1, fontSize: 13, fontWeight: '500', opacity: 0.88 },
    body: { flex: 1, minHeight: 0 },
    surface: { flex: 1 },
    compactHeader: { position: 'absolute', top: 8, left: EDGE, right: EDGE, height: BUTTON, flexDirection: 'row', justifyContent: 'space-between', zIndex: 2 },
    overlay: {
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        paddingHorizontal: 36,
    },
    overlayTitle: { ...Typography.default(), fontSize: 16, lineHeight: 22, textAlign: 'center' },
    overlayDetail: { ...Typography.default(), fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: -4 },
    command: { alignSelf: 'stretch', borderRadius: ui.radius.control, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 10, gap: 6 },
    commandText: { ...Typography.mono(), fontSize: 12, lineHeight: 17 },
    commandCopy: { ...Typography.default(), fontSize: 13, alignSelf: 'flex-end' },
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
    topCard: { top: 4, right: 8, minWidth: 220, maxWidth: '88%' },
    clipboardCard: { left: EDGE, minWidth: 220, maxWidth: 300 },
    menuRow: { minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 18 },
    menuLabel: { ...Typography.default(), flex: 1, fontSize: 15 },
    helpRow: { flexDirection: 'row', alignItems: 'baseline', gap: 14, paddingHorizontal: 18, paddingVertical: 7 },
    compactHelpRow: { paddingVertical: 2 },
    helpGesture: { ...Typography.default(), width: 100, fontSize: 14, lineHeight: 18 },
    helpEffect: { ...Typography.default(), flex: 1, fontSize: 14, lineHeight: 18 },
    keyRow: { position: 'absolute', left: 0, right: 0, backgroundColor: '#000' },
    controls: {
        position: 'absolute',
        left: EDGE,
        right: EDGE,
        height: BUTTON,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    noticeLane: { position: 'absolute', left: 0, right: 0, bottom: BUTTON + 12, alignItems: 'center' },
    notice: {
        maxWidth: '96%',
        paddingHorizontal: 14,
        paddingVertical: 9,
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
    },
    noticeText: { ...Typography.default(), fontSize: 13, lineHeight: 18, textAlign: 'center' },
    disabled: { opacity: 0.4 },
    pressed: { opacity: 0.6 },
});
