import React from 'react';
import { View, StyleSheet, Text, Pressable, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { CommandPaletteInput } from '@/components/CommandPalette/CommandPaletteInput';
import { CommandPaletteResults } from '@/components/CommandPalette/CommandPaletteResults';
import { useCommandPalette } from '@/components/CommandPalette/useCommandPalette';
import { Command, CUSTOM_CATEGORY } from '@/components/CommandPalette/types';
import { t } from '@/text';
import { darkTheme } from '@/theme';

interface CommandPaletteProps {
    commands: Command[];
    onClose: () => void;
    title?: string;
    appearance?: 'terminal';
    /** Quiet line under the search field (e.g. no catalogue for this agent kind). */
    quietLine?: string;
}

export function CommandPalette({ commands, onClose, title, appearance, quietLine }: CommandPaletteProps) {
    const { width, height } = useWindowDimensions();
    // The catalogue sheet grows only while the search field holds focus.
    const [searchFocused, setSearchFocused] = React.useState(false);
    const { theme: appTheme } = useUnistyles();
    // A terminal pane stays dark in either app theme, so its command surface
    // uses the same dark chrome. The global navigation palette follows the app.
    const theme = appearance === 'terminal' ? darkTheme : appTheme;
    const sheet = appearance === 'terminal' && width < 500;
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

    // With a query the sections collapse into one ranked list; when nothing
    // matches, the quiet line stays and the Custom row keeps its place.
    const { categories, quiet } = React.useMemo(() => {
        if (searchQuery.trim() === '') {
            return quietLine === undefined
                ? { categories: filteredCategories, quiet: undefined }
                : { categories: filteredCategories.map((category) => ({ ...category, title: '' })), quiet: quietLine };
        }
        const matches = filteredCategories.flatMap((category) => category.commands);
        if (matches.length > 0) return { categories: [{ id: 'results', title: '', commands: matches }], quiet: undefined };
        const custom = commands.filter((command) => command.category === CUSTOM_CATEGORY);
        return { categories: custom.map((command) => ({ id: CUSTOM_CATEGORY, title: '', commands: [command] })), quiet: t('commandPalette.noMatch') };
    }, [searchQuery, filteredCategories, commands, quietLine]);

    return (
        <View accessibilityViewIsModal={sheet} style={[styles.container, sheet && styles.sheet, {
            maxHeight: Math.min(500, height * (searchFocused ? 0.82 : 0.65)),
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.modal.border,
            borderTopColor: theme.colors.divider,
            shadowColor: theme.colors.shadow.color,
        }]}>
            {title !== undefined && <View style={[styles.titleRow, { borderBottomColor: theme.colors.divider }]}>
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
                onFocusChange={setSearchFocused}
            />
            <CommandPaletteResults
                categories={categories}
                selectedIndex={selectedIndex}
                onSelectCommand={handleSelectCommand}
                onSecondaryCommand={handleSecondaryCommand}
                onSelectionChange={setSelectedIndex}
                appearance={appearance}
                quietLine={quiet}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        borderRadius: 12,
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
    sheet: {
        maxWidth: '100%',
        borderTopWidth: StyleSheet.hairlineWidth,
        borderBottomWidth: 0,
        borderLeftWidth: 0,
        borderRightWidth: 0,
        borderRadius: 12,
        shadowOffset: { width: 0, height: -8 },
        shadowOpacity: 0.5,
        shadowRadius: 32,
        elevation: 12,
    },
    titleRow: { minHeight: 50, paddingLeft: 16, paddingRight: 8, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
    title: { flex: 1, fontSize: 16 },
    closeButton: { width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
