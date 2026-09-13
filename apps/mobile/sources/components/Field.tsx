import * as React from 'react';
import { Text, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

/**
 * A labelled form field: the label sits above the control, optionality is
 * in the label, the placeholder explains rather than repeats, and one line
 * underneath carries a hint or the error. Machine values (hosts, tokens,
 * names the computer reports) are mono; human text says `mono={false}`.
 * The focused outline is the form's one accent. Two fields share a row
 * with `style={{ flex: 3 }}` / `{{ flex: 1 }}` inside a row view.
 */
export function Field({ label, optional = false, helper, error, mono = true, icon, style, children, ...input }: {
    label: string;
    optional?: boolean;
    helper?: string;
    error?: string;
    mono?: boolean;
    /** A leading mark inside the box, in the accent: the key beside a secret. */
    icon?: React.ComponentProps<typeof Ionicons>['name'];
    style?: StyleProp<ViewStyle>;
    /** A non-text control (a SegmentedControl) takes the input's place. */
    children?: React.ReactNode;
    /** Cloned in by ItemGroup onto every child; a field has no divider to show. */
    showDivider?: boolean;
} & Omit<TextInputProps, 'style'>) {
    const { theme } = useUnistyles();
    const [focused, setFocused] = React.useState(false);
    const { showDivider: _divider, ...inputProps } = input as typeof input & { showDivider?: boolean };
    return (
        <View style={[styles.field, style]}>
            <Text style={styles.label}>{optional ? `${label} (optional)` : label}</Text>
            {children ?? (
                <View style={[styles.box, focused && { borderColor: theme.colors.formAccent }, error !== undefined && { borderColor: theme.colors.textDestructive }]}>
                    {icon !== undefined && <View style={styles.icon}><Ionicons name={icon} size={18} color={theme.colors.formAccent} /></View>}
                    <TextInput
                        {...inputProps}
                        style={[styles.input, mono ? styles.mono : styles.sans]}
                        placeholderTextColor={theme.colors.textSecondary}
                        accessibilityLabel={inputProps.accessibilityLabel ?? label}
                        autoCapitalize={inputProps.autoCapitalize ?? 'none'}
                        autoCorrect={inputProps.autoCorrect ?? false}
                        onFocus={(event) => { setFocused(true); inputProps.onFocus?.(event); }}
                        onBlur={(event) => { setFocused(false); inputProps.onBlur?.(event); }}
                    />
                </View>
            )}
            {(error ?? helper) !== undefined && (
                <Text style={[styles.helper, error !== undefined && styles.error]}>{error ?? helper}</Text>
            )}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    field: {
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 4,
    },
    label: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        lineHeight: 20,
        color: theme.colors.text,
        marginBottom: 8,
    },
    box: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 48,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        backgroundColor: theme.colors.surfaceHigh,
        paddingHorizontal: 12,
    },
    icon: {
        marginRight: 10,
    },
    input: {
        flex: 1,
        minWidth: 0,
        fontSize: 15,
        lineHeight: 20,
        paddingVertical: 12,
        color: theme.colors.text,
        // The box draws the focus outline; the browser's own must not double it.
        _web: { outlineStyle: 'none' },
    },
    mono: {
        ...Typography.mono('regular'),
    },
    sans: {
        ...Typography.default('regular'),
    },
    helper: {
        ...Typography.default('regular'),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        marginTop: 8,
    },
    error: {
        color: theme.colors.textDestructive,
    },
}));
