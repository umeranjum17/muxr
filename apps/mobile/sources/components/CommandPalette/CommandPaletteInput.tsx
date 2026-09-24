import React from 'react';
import { View, TextInput, StyleSheet, Platform, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { darkThemes } from '@/theme';
import { useLocalSetting } from '@/catalog/store';

interface CommandPaletteInputProps {
    value: string;
    onChangeText: (text: string) => void;
    onKeyPress?: (key: string) => void;
    inputRef?: React.RefObject<TextInput | null>;
    appearance?: 'terminal';
}

export function CommandPaletteInput({ value, onChangeText, onKeyPress, inputRef, appearance }: CommandPaletteInputProps) {
    const { theme: appTheme } = useUnistyles();
    const darkTheme = darkThemes[useLocalSetting('darkSurfaces')];
    const theme = appearance === 'terminal' ? darkTheme : appTheme;
    // A physical keyboard is the only kind on wide screens, so the field can
    // take focus immediately; on a phone the sheet opens with the IME down.
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
        <View style={styles.container}>
            <View style={[styles.field, { backgroundColor: theme.colors.surfaceHigh }]}>
                <Ionicons name="search" size={18} color={theme.colors.textSecondary} />
                <TextInput
                    ref={inputRef}
                    style={[styles.input, { color: theme.colors.text }, Typography.default()]}
                    value={value}
                    onChangeText={onChangeText}
                    placeholder={t('commandPalette.placeholder')}
                    placeholderTextColor={theme.colors.textSecondary}
                    autoFocus={wide}
                    autoCorrect={false}
                    autoCapitalize="none"
                    returnKeyType="go"
                    onKeyPress={handleKeyDown}
                    onSubmitEditing={Platform.OS === 'web' ? undefined : () => onKeyPress?.('Enter')}
                    blurOnSubmit={false}
                />
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: { paddingHorizontal: 12, paddingVertical: 8 },
    field: {
        height: 44,
        borderRadius: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
    },
    input: {
        flex: 1,
        fontSize: 16,
        // Remove outline on web
        ...(Platform.OS === 'web' ? {
            outlineStyle: 'none',
            outlineWidth: 0,
        } as any : {}),
    },
});
