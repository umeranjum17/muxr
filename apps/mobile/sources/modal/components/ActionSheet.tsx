import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { hapticsSelection } from '@/components/haptics';
import { OptionSheet } from '@/components/OptionSheet';
import { Typography } from '@/constants/Typography';
import { AlertButton, AlertModalConfig, ConfirmModalConfig } from '@/modal/types';
import { t } from '@/text';

interface ActionSheetProps {
    config: AlertModalConfig | ConfirmModalConfig;
    onClose: () => void;
    onConfirm?: (value: boolean) => void;
}

/** Every row leads with an icon; a button that names none gets its style's. */
function iconOf(button: AlertButton): NonNullable<AlertButton['icon']> {
    if (button.icon !== undefined) return button.icon;
    if (button.style === 'cancel') return 'close-outline';
    return button.style === 'destructive' ? 'trash-outline' : 'checkmark-circle-outline';
}

function buttonsOf(config: AlertModalConfig | ConfirmModalConfig): AlertButton[] {
    if (config.type === 'confirm') {
        return [
            { text: config.confirmText || t('common.ok'), style: config.destructive ? 'destructive' : 'default' },
            { text: config.cancelText || t('common.cancel'), style: 'cancel' },
        ];
    }
    return config.buttons?.length ? config.buttons : [{ text: t('common.ok') }];
}

/**
 * What walking away from an alert means: its cancel button, or its only
 * button when it has just one (an acknowledgement the caller may act on).
 * A choice with no cancel just closes.
 */
export function dismissAlert(config: AlertModalConfig): void {
    const buttons = config.buttons ?? [];
    const cancel = buttons.find((button) => button.style === 'cancel') ?? (buttons.length === 1 ? buttons[0] : undefined);
    cancel?.onPress?.();
}

/**
 * The one app-styled sheet behind every `Modal.alert` and `Modal.confirm`,
 * on Android and web: title, message, a full-width row per choice, each led
 * by an icon, and the cancel row last. A tap outside, a swipe down or back
 * dismisses it as its cancel.
 */
export function ActionSheet({ config, onClose, onConfirm }: ActionSheetProps) {
    const { theme } = useUnistyles();
    const buttons = buttonsOf(config);
    const ordered = [...buttons.filter((button) => button.style !== 'cancel'), ...buttons.filter((button) => button.style === 'cancel')];

    const dismiss = () => {
        if (config.type === 'confirm') onConfirm?.(false);
        else dismissAlert(config);
        onClose();
    };

    const press = (button: AlertButton) => {
        hapticsSelection();
        // Close first, so a picker or a second sheet the choice opens is not covered.
        onClose();
        if (config.type === 'confirm') onConfirm?.(button.style !== 'cancel');
        else button.onPress?.();
    };

    return (
        <OptionSheet
            visible
            title={config.title}
            options={[]}
            onSelect={() => undefined}
            onClose={dismiss}
            avoidKeyboard={false}
            raised
            body={
                <View style={styles.body}>
                    {!!config.message && <Text style={styles.message}>{config.message}</Text>}
                    {ordered.map((button, index) => {
                        const color = button.style === 'destructive'
                            ? theme.colors.textDestructive
                            : button.style === 'cancel' ? theme.colors.textSecondary : theme.colors.text;
                        return (
                            <Pressable
                                key={index}
                                accessibilityRole="button"
                                onPress={() => press(button)}
                                android_ripple={{ color: theme.colors.surfaceRipple }}
                                style={({ pressed }) => [
                                    styles.row,
                                    button.style === 'cancel' && styles.cancelRow,
                                    pressed && { backgroundColor: theme.colors.surfaceRipple },
                                ]}
                            >
                                <Ionicons name={iconOf(button)} size={22} color={color} />
                                <Text style={[styles.label, { color }, button.style === 'cancel' && styles.cancelLabel]}>{button.text}</Text>
                            </Pressable>
                        );
                    })}
                </View>
            }
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    body: {
        paddingBottom: 4,
    },
    message: {
        fontSize: 15,
        lineHeight: 21,
        color: theme.colors.textSecondary,
        marginHorizontal: 20,
        marginBottom: 12,
        ...Typography.default(),
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        minHeight: 56,
        paddingVertical: 14,
        paddingHorizontal: 20,
    },
    cancelRow: {
        marginTop: 4,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    label: {
        flexShrink: 1,
        fontSize: 17,
        ...Typography.default('semiBold'),
    },
    cancelLabel: {
        ...Typography.default(),
    },
}));
