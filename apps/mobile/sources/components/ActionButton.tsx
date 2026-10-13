import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { WordWrappingText } from './WordWrappingText';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { hapticsLight } from '@/components/haptics';

/**
 * The one button style used across onboarding, pairing and empty states:
 * a full-width pill with a clear primary/secondary/quiet hierarchy, an
 * optional leading icon, and an async action that shows its own spinner.
 * 52px tall, so the touch target always clears 44px.
 */
export const ActionButton = React.memo((props: {
    title: string;
    testID?: string;
    onPress?: () => void;
    action?: () => Promise<unknown>;
    variant?: 'primary' | 'secondary' | 'quiet';
    icon?: keyof typeof Ionicons.glyphMap;
    disabled?: boolean;
    accessibilityLabel?: string;
    /** Let a long title wrap onto more lines at large text instead of cutting it. */
    wrap?: boolean;
}) => {
    const styles = stylesheet;
    const [busy, setBusy] = React.useState(false);
    const [width, setWidth] = React.useState(0);
    const [wordWidth, setWordWidth] = React.useState(0);
    const variant = props.variant ?? 'primary';
    const fontSize = variant === 'quiet' ? 15 : 17;
    const padding = Math.min(props.wrap ? 8 : 24, width / 8);
    const contentWidth = Math.max(0, width - 2 * padding);
    const stacked = props.icon !== undefined && wordWidth + 27 > contentWidth;
    const labelWidth = Math.max(0, contentWidth - (props.icon !== undefined && !stacked ? 27 : 0));
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
            testID={props.testID}
            onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
            disabled={props.disabled || busy}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel ?? props.title}
            accessibilityState={{ disabled: !!props.disabled, busy }}
            style={(p) => [
                styles.base,
                props.wrap && styles.wrap,
                { paddingHorizontal: padding },
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
                <View style={[styles.content, stacked && styles.stackedContent]}>
                    {props.icon !== undefined && (
                        <Ionicons
                            name={props.icon}
                            size={19}
                            color={variant === 'primary' ? styles.primaryText.color : variant === 'quiet' ? styles.quietText.color : styles.secondaryText.color}
                        />
                    )}
                    <WordWrappingText fontSize={fontSize} availableWidth={labelWidth} onWordWidth={setWordWidth}
                        style={[
                            styles.text,
                            variant === 'primary' && styles.primaryText,
                            variant === 'secondary' && styles.secondaryText,
                            variant === 'quiet' && styles.quietText,
                            props.wrap && styles.wrapText,
                        ]}
                        numberOfLines={props.wrap ? undefined : 1}
                    >
                        {props.title}
                    </WordWrappingText>
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
    wrap: { height: undefined, minHeight: 52, paddingVertical: 8, paddingHorizontal: 8 },
    stackedContent: { flexDirection: 'column', gap: 4 },
    wrapText: { flexShrink: 1, minWidth: 0, textAlign: 'center' },
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
        width: '100%',
        justifyContent: 'center',
    },
    text: {
        ...Typography.default('semiBold'),
        textAlign: 'center',
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
    },
}));
