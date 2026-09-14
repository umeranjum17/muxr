import React from 'react';
import { View, TextInput, StyleSheet, Platform, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { darkTheme } from '@/theme';

interface CommandPaletteInputProps {
    value: string;
    onChangeText: (text: string) => void;
    onKeyPress?: (key: string) => void;
    inputRef?: React.RefObject<TextInput | null>;
    appearance?: 'terminal';
    compact?: boolean;
}

export function CommandPaletteInput({ value, onChangeText, onKeyPress, inputRef, appearance, compact }: CommandPaletteInputProps) {
    const { theme: appTheme } = useUnistyles();
    const theme = appearance === 'terminal' ? darkTheme : appTheme;
    const wide = useWindowDimensions().width >= 500;
    const handleKeyDown = React.useCallback((e: any) => {
        if (Platform.OS === 'web' && onKeyPress) {
            const key = e.nativeEvent.key;
            
            // Handle navigation keys
            if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(key)) {
                e.preventDefault();
                e.stopPropagation();
                onKeyPress(key);
            }
        }
    }, [onKeyPress]);

    return (
        <View style={[styles.container, { borderBottomColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh }]}>
            <TextInput
                ref={inputRef}
                style={[styles.input, { paddingHorizontal: wide ? 24 : 16, paddingVertical: compact ? 8 : wide ? 18 : 12, fontSize: wide ? 20 : 16, color: theme.colors.text }, Typography.default()]}
                value={value}
                onChangeText={onChangeText}
                placeholder={t('commandPalette.placeholder')}
                placeholderTextColor={theme.colors.textSecondary}
                autoFocus
                autoCorrect={false}
                autoCapitalize="none"
                returnKeyType="go"
                onKeyPress={handleKeyDown}
                onSubmitEditing={Platform.OS === 'web' ? undefined : () => onKeyPress?.('Enter')}
                blurOnSubmit={false}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        borderBottomWidth: 1,
    },
    input: {
        letterSpacing: -0.3,
        // Remove outline on web
        ...(Platform.OS === 'web' ? {
            outlineStyle: 'none',
            outlineWidth: 0,
        } as any : {}),
    },
});
