import React from 'react';
import { Platform, View, Text, Pressable, useWindowDimensions } from 'react-native';
import { BaseModal } from '@/modal/components/BaseModal';
import { AlertModalConfig, ConfirmModalConfig } from '@/modal/types';
import { Typography } from '@/constants/Typography';
import { StyleSheet } from 'react-native';
import { ScopedTheme, useUnistyles } from 'react-native-unistyles';
import { MobileGlassSurface } from '@/components/MobileGlass';

interface WebAlertModalProps {
    config: AlertModalConfig | ConfirmModalConfig;
    onClose: () => void;
    onConfirm?: (value: boolean) => void;
    /**
     * Paint the dialog from a fixed theme. A sheet over the session forces
     * `dark`, but on native the surrounding `ScopedTheme` does not survive the
     * RN Modal boundary, so the dialog falls back to the app theme and clashes
     * with the sheet. Re-apply the scope inside the modal content here.
     */
    surface?: 'dark' | 'light';
    /**
     * Render the dialog on a fully opaque solid surface instead of the
     * translucent native glass. A confirm opened over a busy screen (the
     * Computers switch confirm over a terminal) must not let text behind
     * the dialog show through its body.
     */
    opaque?: boolean;
}

type WebAlertModalContentProps = Omit<WebAlertModalProps, 'surface'>;

function WebAlertModalContent({ config, onClose, onConfirm, opaque }: WebAlertModalContentProps) {
    const { theme } = useUnistyles();
    const { width: windowWidth } = useWindowDimensions();
    const isConfirm = config.type === 'confirm';
    // The dialog is 270 wide, but on the narrowest phones (a 270 dp viewport)
    // that fills the screen edge to edge. Keep a plain side inset so it never
    // touches the edges, while wider screens keep the fixed 270 width.
    const dialogWidth = Math.min(270, Math.max(160, Math.round(windowWidth - 48)));

    const handleButtonPress = (buttonIndex: number) => {
        if (isConfirm && onConfirm) {
            onConfirm(buttonIndex === 1);
        } else if (!isConfirm && config.buttons?.[buttonIndex]?.onPress) {
            config.buttons[buttonIndex].onPress!();
        }
        onClose();
    };

    const buttons = isConfirm
        ? [
            { text: config.cancelText || 'Cancel', style: 'cancel' as const },
            { text: config.confirmText || 'OK', style: config.destructive ? 'destructive' as const : 'default' as const }
        ]
        : config.buttons || [{ text: 'OK', style: 'default' as const }];

    const styles = StyleSheet.create({
        container: {
            backgroundColor: opaque
                ? theme.colors.surface
                : Platform.select({
                    web: theme.colors.surface,
                    ios: theme.colors.glass.overlay,
                    android: theme.colors.glass.backgroundStrong,
                    default: theme.colors.surface,
                }),
            borderRadius: 14,
            width: dialogWidth,
            overflow: 'hidden',
            borderWidth: Platform.OS === 'web' ? 0 : StyleSheet.hairlineWidth,
            borderColor: theme.colors.glass.border,
            shadowColor: theme.colors.shadow.color,
            shadowOffset: {
                width: 0,
                height: 2
            },
            shadowOpacity: 0.25,
            shadowRadius: 4,
            elevation: 5
        },
        content: {
            paddingHorizontal: 16,
            paddingTop: 20,
            paddingBottom: 16,
            alignItems: 'center'
        },
        title: {
            fontSize: 17,
            textAlign: 'center',
            color: theme.colors.text,
            marginBottom: 4
        },
        message: {
            fontSize: 13,
            textAlign: 'center',
            color: theme.colors.text,
            marginTop: 4,
            lineHeight: 18
        },
        buttonContainer: {
            borderTopWidth: 1,
            borderTopColor: theme.colors.divider,
            flexDirection: 'row'
        },
        button: {
            flex: 1,
            paddingVertical: 11,
            alignItems: 'center',
            justifyContent: 'center'
        },
        buttonPressed: {
            backgroundColor: theme.colors.divider
        },
        buttonSeparator: {
            width: 1,
            backgroundColor: theme.colors.divider
        },
        buttonText: {
            fontSize: 17,
            color: theme.colors.textLink
        },
        cancelText: {
            fontWeight: '400'
        },
        destructiveText: {
            color: theme.colors.textDestructive
        }
    });

    const body = (
        <>
            <View style={styles.content}>
                <Text style={[styles.title, Typography.default('semiBold')]}>
                    {config.title}
                </Text>
                {config.message && (
                    <Text style={[styles.message, Typography.default()]}>
                        {config.message}
                    </Text>
                )}
            </View>

            {/* Three or more choices stack, as a system alert does, so none is squeezed. */}
            <View style={[styles.buttonContainer, buttons.length > 2 && { flexDirection: 'column' }]}>
                {buttons.map((button, index) => (
                    <React.Fragment key={index}>
                        {index > 0 && <View style={buttons.length > 2 ? { height: 1, backgroundColor: theme.colors.divider } : styles.buttonSeparator} />}
                        <Pressable
                            style={({ pressed }) => [
                                styles.button,
                                buttons.length > 2 && { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' },
                                pressed && styles.buttonPressed
                            ]}
                            onPress={() => handleButtonPress(index)}
                        >
                            <Text style={[
                                styles.buttonText,
                                button.style === 'cancel' && styles.cancelText,
                                button.style === 'destructive' && styles.destructiveText,
                                Typography.default(button.style === 'cancel' ? undefined : 'semiBold')
                            ]}>
                                {button.text}
                            </Text>
                        </Pressable>
                    </React.Fragment>
                ))}
            </View>
        </>
    );

    // An opaque dialog skips the glass entirely: a translucent blur layer over
    // a busy screen lets the text behind show through the dialog body.
    if (opaque) {
        return <View style={styles.container}>{body}</View>;
    }

    return (
        <MobileGlassSurface
            enabled={Platform.OS !== 'web'}
            nativeEffect
            glassEffectStyle="regular"
            intensity={88}
            tintColor={theme.colors.glass.overlayTint}
            style={styles.container}
        >
            {body}
        </MobileGlassSurface>
    );
}

export function WebAlertModal({ config, onClose, onConfirm, surface, opaque }: WebAlertModalProps) {
    const content = <WebAlertModalContent config={config} onClose={onClose} onConfirm={onConfirm} opaque={opaque} />;

    return (
        <BaseModal visible={true} onClose={onClose} closeOnBackdrop={false}>
            {surface === undefined ? content : <ScopedTheme name={surface}>{content}</ScopedTheme>}
        </BaseModal>
    );
}
