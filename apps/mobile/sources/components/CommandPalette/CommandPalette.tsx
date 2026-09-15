import React from 'react';
import { View, StyleSheet, Text, Pressable, useWindowDimensions, Keyboard, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { CommandPaletteInput } from '@/components/CommandPalette/CommandPaletteInput';
import { CommandPaletteResults } from '@/components/CommandPalette/CommandPaletteResults';
import { useCommandPalette } from '@/components/CommandPalette/useCommandPalette';
import { Command } from '@/components/CommandPalette/types';
import { darkTheme } from '@/theme';

interface CommandPaletteProps {
    commands: Command[];
    onClose: () => void;
    title?: string;
    appearance?: 'terminal';
}

export function CommandPalette({ commands, onClose, title, appearance }: CommandPaletteProps) {
    const { height } = useWindowDimensions();
    const [keyboardVisible, setKeyboardVisible] = React.useState(() => Platform.OS !== 'web' && Keyboard.isVisible());
    React.useEffect(() => {
        if (Platform.OS === 'web') return;
        const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
        const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
        return () => { show.remove(); hide.remove(); };
    }, []);
    const compact = height < 500 || keyboardVisible;
    const { theme: appTheme } = useUnistyles();
    // A terminal pane stays dark in either app theme, so its command surface
    // uses the same dark chrome. The global navigation palette follows the app.
    const theme = appearance === 'terminal' ? darkTheme : appTheme;
    const {
        searchQuery,
        selectedIndex,
        filteredCategories,
        inputRef,
        handleSearchChange,
        handleSelectCommand,
        handleSecondaryCommand,
        handleKeyPress,
        setSelectedIndex,
    } = useCommandPalette(commands, onClose);

    return (
        <View style={[styles.container, { maxHeight: Math.min(500, height * (compact ? 0.82 : 0.65)), backgroundColor: theme.colors.surface, borderColor: theme.colors.modal.border, shadowColor: theme.colors.shadow.color }]}>
            {title !== undefined && <View style={[styles.titleRow, { minHeight: compact ? 40 : 50, borderBottomColor: theme.colors.divider }]}>
                <Text numberOfLines={1} style={[styles.title, { color: theme.colors.text }, Typography.default('semiBold')]}>{title}</Text>
                <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close command palette" hitSlop={8}
                    style={({ pressed }) => [styles.closeButton, { backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent' }]}>
                    <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                </Pressable>
            </View>}
            <CommandPaletteInput
                value={searchQuery}
                onChangeText={handleSearchChange}
                onKeyPress={handleKeyPress}
                inputRef={inputRef}
                appearance={appearance}
                compact={compact}
            />
            <CommandPaletteResults
                categories={filteredCategories}
                selectedIndex={selectedIndex}
                onSelectCommand={handleSelectCommand}
                onSecondaryCommand={handleSecondaryCommand}
                onSelectionChange={setSelectedIndex}
                appearance={appearance}
                compact={compact}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        borderRadius: 16,
        width: '100%',
        maxWidth: 800,
        maxHeight: 500,
        flexShrink: 1,
        overflow: 'hidden',
        shadowOffset: {
            width: 0,
            height: 20,
        },
        shadowOpacity: 0.25,
        shadowRadius: 40,
        elevation: 20,
        borderWidth: 1,
    },
    titleRow: { minHeight: 50, paddingLeft: 16, paddingRight: 8, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
    title: { flex: 1, fontSize: 16 },
    closeButton: { width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
