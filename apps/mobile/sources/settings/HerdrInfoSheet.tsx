import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';

/**
 * The exact command a person runs on their own computer to see the same
 * sessions the app shows. The host serves Herdr's default session, so no
 * --session flag: this is the whole command.
 */
export const HERDR_AGENT_LIST_COMMAND = 'herdr agent list';

/**
 * Bottom sheet behind the Settings "Herdr" row: one plain sentence naming
 * Herdr, the exact command in a monospace block, a Copy button with the
 * usual inline copied feedback, and a close action. Opened with
 * `Modal.show({ component: HerdrInfoSheet, align: 'bottom' })`.
 */
export function HerdrInfoSheet({ onClose }: { onClose?: () => void }) {
    const [copied, setCopied] = React.useState(false);
    const copy = React.useCallback(() => {
        void Clipboard.setStringAsync(HERDR_AGENT_LIST_COMMAND)
            .then(() => setCopied(true))
            .catch(() => Modal.alert('Copy failed', 'Please try again.'));
    }, []);
    return (
        <View style={styles.sheet}>
            <View style={styles.handleRow}>
                <View style={styles.handle} />
            </View>
            <Text style={styles.title} accessibilityRole="header">Herdr runs your sessions</Text>
            <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
                <Text style={styles.sentence}>muxr runs your sessions with Herdr on your computer.</Text>
                <Text style={styles.label}>Run this on your computer to see those same sessions:</Text>
                <View style={styles.commandBox}>
                    <Text selectable style={styles.command} accessibilityLabel={`Command: ${HERDR_AGENT_LIST_COMMAND}`}>
                        {HERDR_AGENT_LIST_COMMAND}
                    </Text>
                </View>
                <Pressable
                    onPress={copy}
                    accessibilityRole="button"
                    accessibilityLabel={copied ? 'Copy command, copied' : 'Copy command'}
                    style={({ pressed }) => [styles.copyButton, pressed && styles.pressed]}
                >
                    <Ionicons
                        name={copied ? 'checkmark-outline' : 'copy-outline'}
                        size={19}
                        color={copied ? '#34C759' : '#007AFF'}
                    />
                    <Text style={styles.copyText}>{copied ? 'Copied' : 'Copy'}</Text>
                </Pressable>
                <Pressable
                    onPress={onClose}
                    accessibilityRole="button"
                    accessibilityLabel="Close"
                    style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
                >
                    <Text style={styles.closeText}>Close</Text>
                </Pressable>
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    sheet: {
        width: '100%',
        maxWidth: 560,
        alignSelf: 'center',
        // Tall content scrolls inside instead of pushing past a short screen.
        maxHeight: '82%',
        backgroundColor: theme.colors.groupped.background,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        overflow: 'hidden',
    },
    handleRow: {
        alignItems: 'center',
        paddingTop: 8,
    },
    handle: {
        width: 36,
        height: 4,
        borderRadius: 2,
        backgroundColor: theme.colors.textSecondary,
        opacity: 0.5,
    },
    title: {
        fontSize: 22,
        color: theme.colors.text,
        paddingHorizontal: 20,
        paddingTop: 12,
        paddingBottom: 4,
        ...Typography.default('semiBold'),
    },
    body: {
        flexGrow: 0,
        flexShrink: 1,
    },
    bodyContent: {
        paddingHorizontal: 20,
        paddingTop: 8,
        paddingBottom: 24,
        gap: 12,
    },
    sentence: {
        fontSize: 15,
        lineHeight: 22,
        color: theme.colors.text,
        ...Typography.default(),
    },
    label: {
        fontSize: 13,
        lineHeight: 19,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    commandBox: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
    command: {
        // The block wraps inside the pop-up instead of clipping at 270 dp.
        flexShrink: 1,
        flexWrap: 'wrap',
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text,
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    copyButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        borderRadius: 12,
        paddingVertical: 12,
        backgroundColor: theme.colors.surfaceHigh,
    },
    pressed: {
        opacity: 0.6,
    },
    copyText: {
        fontSize: 16,
        color: '#007AFF',
        ...Typography.default('semiBold'),
    },
    closeButton: {
        alignItems: 'center',
        borderRadius: 12,
        paddingVertical: 12,
    },
    closeText: {
        fontSize: 16,
        color: theme.colors.textLink,
        ...Typography.default('semiBold'),
    },
}));
