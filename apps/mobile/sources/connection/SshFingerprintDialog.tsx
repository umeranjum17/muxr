import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

/**
 * The SSH host-fingerprint confirmation as an in-app dialog instead of the
 * platform alert. A platform `Alert.alert` cannot be styled: at 270 dp with
 * the system font at its largest the message's fingerprint sits below the
 * fold, and CANCEL renders half-clipped on the dialog's bottom edge where a
 * tap on its visible glyphs does nothing. This dialog keeps the exact copy
 * and button order, stacks both buttons full-width so none is squeezed, and
 * scrolls only the message while both answers stay on screen. The
 * fingerprint is deliberately not selectable: a selectable Android text
 * takes focus when the dialog opens, which scrolls the title off the top
 * before the user reads anything.
 *
 * Opened with `confirmSshFingerprint(fingerprint)` from `./ui` (pair and
 * Connection-settings SSH flows); both keep passing the probed fingerprint
 * and awaiting an explicit answer before any login material is sent.
 */
export function SshFingerprintDialog({ fingerprint, onConfirm, onCancel }: {
    fingerprint: string;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    const { theme } = useUnistyles();
    const { width: windowWidth, height: windowHeight } = useWindowDimensions();
    // Same side inset as the web alert dialog: a fixed 270 wide card fills a
    // 270 dp viewport edge to edge, so shrink with the window instead.
    const dialogWidth = Math.min(340, Math.max(160, Math.round(windowWidth - 48)));
    const styles = StyleSheet.create({
        container: {
            backgroundColor: theme.colors.surface,
            borderRadius: 14,
            width: dialogWidth,
            maxHeight: Math.round(windowHeight * 0.8),
            overflow: 'hidden',
            borderWidth: Platform.OS === 'web' ? 0 : StyleSheet.hairlineWidth,
            borderColor: theme.colors.glass.border,
            shadowColor: theme.colors.shadow.color,
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.25,
            shadowRadius: 4,
            elevation: 5,
        },
        scroll: { flexGrow: 0 },
        content: {
            paddingHorizontal: 16,
            paddingTop: 20,
            paddingBottom: 16,
            alignItems: 'center',
        },
        title: {
            fontSize: 17,
            textAlign: 'center',
            color: theme.colors.text,
            marginBottom: 4,
        },
        message: {
            fontSize: 13,
            textAlign: 'center',
            color: theme.colors.text,
            marginTop: 8,
            lineHeight: 18,
        },
        fingerprint: {
            ...Typography.mono(),
            fontSize: 13,
            lineHeight: 18,
            textAlign: 'center',
            color: theme.colors.text,
            marginTop: 8,
        },
        buttonColumn: {
            borderTopWidth: 1,
            borderTopColor: theme.colors.divider,
        },
        button: {
            paddingVertical: 13,
            paddingHorizontal: 12,
            alignItems: 'center',
            justifyContent: 'center',
        },
        buttonPressed: {
            backgroundColor: theme.colors.divider,
        },
        buttonSeparator: {
            height: 1,
            backgroundColor: theme.colors.divider,
        },
        buttonText: {
            fontSize: 17,
            textAlign: 'center',
            color: theme.colors.textLink,
        },
        cancelText: {
            fontWeight: '400',
        },
    });
    const body = (
        <>
            <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
                <Text style={[styles.title, Typography.default('semiBold')]}>Check SSH fingerprint</Text>
                <Text style={[styles.message, Typography.default()]}>
                    Compare this fingerprint with your provider console before continuing.
                </Text>
                <Text style={styles.fingerprint}>{fingerprint}</Text>
                <Text style={[styles.message, Typography.default()]}>No login details have been sent.</Text>
            </ScrollView>
            {/* Stacked full-width, Cancel first like the platform alert's
                button order, so a long confirm label wraps inside its own
                row instead of squeezing its neighbour. */}
            <View style={styles.buttonColumn}>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Cancel"
                    style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
                    onPress={onCancel}
                >
                    <Text style={[styles.buttonText, styles.cancelText, Typography.default()]}>Cancel</Text>
                </Pressable>
                <View style={styles.buttonSeparator} />
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Fingerprint matches"
                    style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
                    onPress={onConfirm}
                >
                    <Text style={[styles.buttonText, Typography.default('semiBold')]}>Fingerprint matches</Text>
                </Pressable>
            </View>
        </>
    );
    // An opaque surface keeps the settings text behind out of the fingerprint.
    return <View style={styles.container}>{body}</View>;
}

