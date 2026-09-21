import * as React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { DesktopView, useDesktopSession, type SessionSnapshot } from '@desklink/react-native';

import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { ui } from '@/components/ui';
import { Modal } from '@/modal';
import { createDesktopSignaling } from '../application/desktopSignaling';
import { desktopCopy } from '../model/desktopCopy';

export interface DesktopSurfaceProps {
    onExit: () => void;
}

/**
 * The live desktop, inside the conversation.
 *
 * One controller, one surface: the picture fills the screen, and the only chrome
 * is what the user cannot do with the desktop's own keyboard — the native
 * keyboard toggle, the two explicit clipboard directions, and returning to the
 * conversation. Everything else is the desktop.
 */
export function DesktopSurface({ onExit }: DesktopSurfaceProps) {
    const { theme } = useUnistyles();
    const [clipboardBusy, setClipboardBusy] = React.useState(false);
    const [notice, setNotice] = React.useState<string | null>(null);
    const [keyboardOpen, setKeyboardOpen] = React.useState(false);

    const session = useDesktopSession({
        authorize: React.useCallback(async () => ({
            signaling: createDesktopSignaling({
                permissions: ['view', 'control', 'clipboard'],
                maxWidth: 1280,
                maxHeight: 800,
            }),
            session: { permissions: ['view', 'control', 'clipboard'], maxWidth: 1280, maxHeight: 800 },
        }), []),
        onError: (failure) => setNotice(failure.message),
    });

    const { connect, close, snapshot } = session;

    // Opening is a user action: this screen is on screen because the user asked
    // for the desktop, and the host still has to consent to the capture.
    React.useEffect(() => {
        void connect();
        return () => {
            void close('left the desktop');
        };
    }, [connect, close]);

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
            const text = await session.copyRemoteToLocal();
            await Clipboard.setStringAsync(text);
            setNotice(text === '' ? 'The desktop clipboard was empty.' : 'Copied to this phone.');
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

    const leave = React.useCallback(() => {
        session.releaseHeld();
        void close('returned to the conversation');
        onExit();
    }, [close, onExit, session]);

    const status = describe(desktopCopy, snapshot);
    const live = snapshot.status === 'live';

    return (
        <View style={[styles.screen, { backgroundColor: theme.colors.groupped.background }]}>
            <View style={styles.body}>
                <DesktopView sessionId={session.nativeId} style={styles.surface} />
                {!live && (
                    <View style={[styles.overlay, { backgroundColor: theme.colors.groupped.background }]}>
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

            {notice !== null && (
                <Text
                    accessibilityLiveRegion="polite"
                    numberOfLines={2}
                    style={[styles.notice, { color: theme.colors.textSecondary, borderTopColor: theme.colors.divider }]}
                >
                    {notice}
                </Text>
            )}

            <View style={[styles.tools, { backgroundColor: theme.colors.surface, borderTopColor: theme.colors.divider }]}>
                <ToolButton
                    icon="chevron-back"
                    label="Conversation"
                    disabled={false}
                    onPress={leave}
                />
                <ToolButton
                    icon={keyboardOpen ? 'keypad' : 'keypad-outline'}
                    label="Keyboard"
                    disabled={!live}
                    onPress={toggleKeyboard}
                />
                <ToolButton
                    icon="download-outline"
                    label="Copy from desktop"
                    disabled={!live || clipboardBusy}
                    onPress={() => void copyFromDesktop()}
                />
                <ToolButton
                    icon="cloud-upload-outline"
                    label="Paste to desktop"
                    disabled={!live || clipboardBusy}
                    onPress={() => void pasteToDesktop()}
                />
            </View>
        </View>
    );
}

function ToolButton({
    icon,
    label,
    disabled,
    onPress,
}: {
    icon: React.ComponentProps<typeof Ionicons>['name'];
    label: string;
    disabled: boolean;
    onPress: () => void;
}) {
    const { theme } = useUnistyles();
    return (
        <Pressable
            onPress={onPress}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled }}
            style={[styles.tool, disabled && styles.toolDisabled]}
        >
            <Ionicons name={icon} size={20} color={theme.colors.text} />
        </Pressable>
    );
}

/** What the overlay says, as one decision, so the states cannot drift apart. */
function describe(
    copy: typeof desktopCopy,
    snapshot: SessionSnapshot,
): { title: string; detail?: string; spinner: boolean; canRetry: boolean } {
    if (snapshot.status === 'failed') {
        return {
            title: copy.failedTitle,
            detail: snapshot.failure?.message ?? copy.failedBody,
            spinner: false,
            canRetry: true,
        };
    }
    if (snapshot.status === 'ended') {
        return { title: copy.endedTitle, detail: copy.endedBody, spinner: false, canRetry: true };
    }
    return {
        title: snapshot.status === 'reconnecting' ? copy.reconnectingTitle : copy.startingTitle,
        detail: snapshot.status === 'reconnecting' ? copy.reconnectingBody : copy.startingBody,
        spinner: true,
        canRetry: false,
    };
}

const styles = StyleSheet.create({
    // `flex: 1` alone collapses to nothing inside a web route that has no
    // sized ancestor; the explicit percentage is what gives the live surface a
    // box on both platforms.
    screen: { flex: 1, width: '100%', height: '100%' },
    body: { flex: 1, minHeight: 0 },
    surface: { flex: 1 },
    overlay: {
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
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderTopWidth: StyleSheet.hairlineWidth,
    },
    tools: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-around',
        height: 56,
        borderTopWidth: StyleSheet.hairlineWidth,
    },
    tool: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
    toolDisabled: { opacity: 0.4 },
});
