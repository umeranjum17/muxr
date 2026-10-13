import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
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
    const variant = props.variant ?? 'primary';
    const labelStyle = [
        styles.text,
        variant === 'primary' && styles.primaryText,
        variant === 'secondary' && styles.secondaryText,
        variant === 'quiet' && styles.quietText,
        props.wrap && styles.wrapText,
    ];
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
            disabled={props.disabled || busy}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel ?? props.title}
            accessibilityState={{ disabled: !!props.disabled, busy }}
            style={(p) => [
                styles.base,
                props.wrap && styles.wrap,
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
                <View style={[styles.content, props.wrap && styles.wrapContent, props.wrap && styles.wrapRow]}>
                    {props.icon !== undefined && (
                        <Ionicons
                            name={props.icon}
                            size={19}
                            color={variant === 'primary' ? styles.primaryText.color : variant === 'quiet' ? styles.quietText.color : styles.secondaryText.color}
                        />
                    )}
                    {props.wrap ? (
                        <View style={styles.wrapLabel}>
                            <WordWrappingText
                                fontSize={variant === 'quiet' ? 15 : 17}
                                style={labelStyle}
                            >
                                {props.title}
                            </WordWrappingText>
                        </View>
                    ) : (
                        <Text style={labelStyle} numberOfLines={1}>
                            {props.title}
                        </Text>
                    )}
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
    wrapContent: { maxWidth: '100%' },
    // A row child that may not shrink below its longest word on web
    // (min-width: auto), so the label spills out of the pill instead of
    // wrapping; native measures shrunk text by wrapping already.
    //
    // The row itself wraps: on a very narrow screen the icon keeps its size
    // and the label flows onto its own line at the pill's full width instead
    // of squeezing beside the icon into two-character lines that stack the
    // button taller than the viewport. The row spans the pill so the label
    // measures the full width, not the longest word: without it the row
    // shrink-wraps to the longest word and the label breaks inside that.
    // Single-line buttons measure exactly as before: the row already spans
    // its content, and centering content in a full-width row draws the same.
    wrapRow: { width: '100%', flexWrap: 'wrap', justifyContent: 'center' },
    wrapLabel: { flexGrow: 1, flexBasis: 0, minWidth: 0 },
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
