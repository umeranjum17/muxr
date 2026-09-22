import * as React from 'react';
import { ActivityIndicator, BackHandler, Platform, Pressable, StyleSheet, View } from 'react-native';
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
import { createDesktopSignaling } from '../application/desktopSignaling';
import { desktopCopy } from '../model/desktopCopy';
import { describeDesktopOverlay } from '../model/desktopOverlay';
import { DESKTOP_KEY_ROW_HEIGHT, DesktopKeyRow } from './DesktopKeyRow';

type DesktopPermission = 'view' | 'control' | 'clipboard';

export interface DesktopSurfaceProps {
    onExit: () => void;
}

/**
 * The live desktop, inside the conversation.
 *
 * One controller, one surface: the picture fills the screen, and the only chrome
 * is what the user cannot do with the desktop's own keyboard — the native
 * keyboard toggle, the keys a phone keyboard lacks while it is open, the two
 * explicit clipboard directions, and returning to the conversation. Everything
 * else is the desktop.
 */
export function DesktopSurface({ onExit }: DesktopSurfaceProps) {
    const { theme } = useUnistyles();
    const [clipboardBusy, setClipboardBusy] = React.useState(false);
    const [notice, setNotice] = React.useState<string | null>(null);
    const [keyboardOpen, setKeyboardOpen] = React.useState(false);
    const [clipboardAvailable, setClipboardAvailable] = React.useState(false);
    const [clipboardOpen, setClipboardOpen] = React.useState(false);
    const keyboard = useKeyboardState();
    const insets = useSafeAreaInsets();

    const session = useDesktopSession({
        // Ask the host what it can actually do before requesting scope: a host
        // whose clipboard backend is absent must not be asked for a permission
        // whose every use would fail.
        authorize: React.useCallback(async () => {
            const capabilities = await sync.request('desktop.capabilities', {}).catch(() => null);
            const canClipboard = capabilities?.clipboard === true;
            setClipboardAvailable(canClipboard);
            const permissions: DesktopPermission[] = canClipboard
                ? ['view', 'control', 'clipboard']
                : ['view', 'control'];
            return {
                signaling: createDesktopSignaling({ permissions, maxWidth: 1280, maxHeight: 800 }),
                session: { permissions, maxWidth: 1280, maxHeight: 800 },
            };
        }, []),
        onError: (failure) => setNotice(failure.message),
    });

    const { connect, close, snapshot, releaseHeld, hideKeyboard } = session;

    // Opening is a user action: this screen is on screen because the user asked
    // for the desktop, and the host still has to consent to the capture.
    React.useEffect(() => {
        void connect();
        return () => {
            releaseHeld();
            hideKeyboard();
            void close('left the desktop');
        };
    }, [connect, close, releaseHeld, hideKeyboard]);

    React.useEffect(() => setKeyboardOpen(keyboard.isVisible), [keyboard.isVisible]);

    const toggleKeyboard = React.useCallback(() => {
        if (keyboardOpen) {
            session.hideKeyboard();
            setKeyboardOpen(false);
            return;
        }
        session.showKeyboard();
        setKeyboardOpen(true);
    }, [keyboardOpen, session]);

    const copyFromDesktop = React.useCallback(async () => {
        setClipboardBusy(true);
        setNotice(null);
        try {
            const { text, truncated } = await session.copyRemoteToLocal();
            await Clipboard.setStringAsync(text);
            if (truncated) setNotice('Copied the start of the desktop clipboard; the rest was too large.');
            else if (text === '') setNotice('The desktop clipboard was empty.');
            else setNotice('Copied to this phone.');
        } catch (error) {
            setNotice(error instanceof Error ? error.message : 'Could not copy from the desktop.');
        } finally {
            setClipboardBusy(false);
        }
    }, [session]);

    const pasteToDesktop = React.useCallback(async () => {
        setClipboardBusy(true);
        setNotice(null);
        try {
            const text = await Clipboard.getStringAsync();
            await session.pasteLocalToRemote(text);
            setNotice('Sent to the desktop clipboard.');
        } catch (error) {
            setNotice(error instanceof Error ? error.message : 'Could not paste to the desktop.');
        } finally {
            setClipboardBusy(false);
        }
    }, [session]);

    React.useEffect(() => {
        if (Platform.OS !== 'android') return;
        const back = BackHandler.addEventListener('hardwareBackPress', () => {
            if (clipboardOpen) setClipboardOpen(false);
            else onExit();
            return true;
        });
        return () => back.remove();
    }, [clipboardOpen, onExit]);

    const status = describeDesktopOverlay(snapshot);
    const live = snapshot.status === 'live';
    const clipboardUnavailable = live && !clipboardAvailable;
    const shownNotice = live ? notice ?? (clipboardUnavailable ? desktopCopy.clipboardUnavailable : null) : null;
    const keyRowShown = live && keyboardOpen;
    const buttonBottom = (keyboard.isVisible ? 12 : Math.max(insets.bottom, 8) + 12) + (keyRowShown ? DESKTOP_KEY_ROW_HEIGHT : 0);

    return (
        <View style={styles.screen}>
            <View style={styles.body}>
                <DesktopView sessionId={session.nativeId} style={styles.surface} />
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
            </View>

            {keyRowShown && (
                <View style={{ paddingBottom: keyboard.isVisible ? 0 : insets.bottom }}>
                    <DesktopKeyRow session={session} />
                </View>
            )}

            {shownNotice !== null && (
                <Text
                    accessibilityLiveRegion="polite"
                    numberOfLines={2}
                    style={[styles.notice, { color: theme.colors.textSecondary, bottom: buttonBottom + 60 }]}
                >
                    {shownNotice}
                </Text>
            )}

            {live && <>
                {clipboardOpen && <>
                    <Pressable style={StyleSheet.absoluteFill} onPress={() => setClipboardOpen(false)} accessibilityLabel="Close clipboard options" />
                    <View style={[styles.clipboardCard, { backgroundColor: theme.colors.surface, bottom: buttonBottom + 56 }]}>
                    <Pressable onPress={() => { setClipboardOpen(false); void copyFromDesktop(); }} disabled={clipboardBusy || !clipboardAvailable} accessibilityRole="button" accessibilityLabel="Copy to Phone" style={styles.clipboardRow}>
                        <Ionicons name="copy-outline" size={22} color={theme.colors.textSecondary} /><Text style={[styles.clipboardLabel, { color: theme.colors.text }]}>Copy to Phone</Text>
                    </Pressable>
                    <Pressable onPress={() => { setClipboardOpen(false); void pasteToDesktop(); }} disabled={clipboardBusy || !clipboardAvailable} accessibilityRole="button" accessibilityLabel="Paste from Phone" style={styles.clipboardRow}>
                        <Ionicons name="clipboard-outline" size={22} color={theme.colors.textSecondary} /><Text style={[styles.clipboardLabel, { color: theme.colors.text }]}>Paste from Phone</Text>
                    </Pressable>
                    </View>
                </>}
                <Pressable onPress={() => setClipboardOpen((open) => !open)} disabled={!clipboardAvailable} accessibilityRole="button" accessibilityLabel="Clipboard" accessibilityState={{ disabled: !clipboardAvailable, expanded: clipboardOpen, busy: clipboardBusy }} style={[styles.floatingButton, styles.clipboardButton, { bottom: buttonBottom }, !clipboardAvailable && styles.toolDisabled]}>
                    <Ionicons name="clipboard-outline" size={24} color={theme.colors.text} />
                </Pressable>
                <Pressable onPress={toggleKeyboard} accessibilityRole="button" accessibilityLabel="Keyboard" style={[styles.floatingButton, styles.keyboardButton, { bottom: buttonBottom }]}>
                    <Ionicons name={keyboardOpen ? 'keypad' : 'keypad-outline'} size={24} color={theme.colors.text} />
                </Pressable>
            </>}
        </View>
    );
}

const styles = StyleSheet.create({
    // `flex: 1` alone collapses to nothing inside a web route that has no
    // sized ancestor; the explicit percentage is what gives the live surface a
    // box on both platforms.
    screen: { flex: 1, width: '100%', height: '100%', backgroundColor: '#000' },
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
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        position: 'absolute',
        left: 18,
        right: 18,
        textAlign: 'center',
    },
    floatingButton: { position: 'absolute', width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: '#29292d', borderWidth: StyleSheet.hairlineWidth, borderColor: '#55555a' },
    clipboardButton: { left: 18 },
    keyboardButton: { right: 18 },
    clipboardCard: { position: 'absolute', left: 18, width: 246, maxWidth: '90%', borderRadius: 18, paddingVertical: 7, zIndex: 3 },
    clipboardRow: { height: 52, flexDirection: 'row', alignItems: 'center', gap: 18, paddingHorizontal: 18 },
    clipboardLabel: { ...Typography.default(), fontSize: 15 },
    toolDisabled: { opacity: 0.4 },
});
