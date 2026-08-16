import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { hapticsLight } from './haptics';

/**
 * The one button style used across onboarding, pairing and empty states:
 * a full-width pill with a clear primary/secondary/quiet hierarchy, an
 * optional leading icon, and an async action that shows its own spinner.
 * 52px tall, so the touch target always clears 44px.
 */
export const ActionButton = React.memo((props: {
    title: string;
    onPress?: () => void;
    action?: () => Promise<unknown>;
    variant?: 'primary' | 'secondary' | 'quiet';
    icon?: keyof typeof Ionicons.glyphMap;
    disabled?: boolean;
    accessibilityLabel?: string;
}) => {
    const styles = stylesheet;
    const [busy, setBusy] = React.useState(false);
    const variant = props.variant ?? 'primary';
    const run = React.useCallback(() => {
        hapticsLight();
        if (props.onPress) {
            props.onPress();
            return;
        }
        if (props.action) {
            setBusy(true);
            void (async () => {
                try {
                    await props.action!();
                } finally {
                    setBusy(false);
                }
            })();
        }
    }, [props.onPress, props.action]);
    return (
        <Pressable
            disabled={props.disabled || busy}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel ?? props.title}
            accessibilityState={{ disabled: !!props.disabled, busy }}
            style={(p) => [
                styles.base,
                variant === 'primary' && styles.primary,
                variant === 'secondary' && styles.secondary,
                variant === 'quiet' && styles.quiet,
                (props.disabled || busy) && { opacity: 0.5 },
                p.pressed && { opacity: 0.85 },
            ]}
            onPress={run}
        >
            {busy ? (
                <ActivityIndicator
                    size="small"
                    color={variant === 'primary' ? styles.primaryText.color : styles.secondaryText.color}
                />
            ) : (
                <View style={styles.content}>
                    {props.icon !== undefined && (
                        <Ionicons
                            name={props.icon}
                            size={19}
                            color={variant === 'primary' ? styles.primaryText.color : variant === 'quiet' ? styles.quietText.color : styles.secondaryText.color}
                        />
                    )}
                    <Text
                        style={[
                            styles.text,
                            variant === 'primary' && styles.primaryText,
                            variant === 'secondary' && styles.secondaryText,
                            variant === 'quiet' && styles.quietText,
                        ]}
                        numberOfLines={1}
                    >
                        {props.title}
                    </Text>
                </View>
            )}
        </Pressable>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    base: {
        height: 52,
        borderRadius: 26,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
        alignSelf: 'stretch',
    },
    primary: {
        backgroundColor: theme.colors.button.primary.background,
    },
    secondary: {
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    quiet: {
        backgroundColor: 'transparent',
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    text: {
        ...Typography.default('semiBold'),
        fontSize: 17,
        includeFontPadding: false,
    },
    primaryText: {
        color: theme.colors.button.primary.tint,
    },
    secondaryText: {
        color: theme.colors.text,
    },
    quietText: {
        color: theme.colors.textSecondary,
        fontSize: 15,
    },
}));
