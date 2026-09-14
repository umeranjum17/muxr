import React from 'react';
import { View, StyleSheet, Text, useWindowDimensions } from 'react-native';
import { CommandPaletteInput } from '@/components/CommandPalette/CommandPaletteInput';
import { CommandPaletteResults } from '@/components/CommandPalette/CommandPaletteResults';
import { useCommandPalette } from '@/components/CommandPalette/useCommandPalette';
import { Command } from '@/components/CommandPalette/types';

interface CommandPaletteProps {
    commands: Command[];
    onClose: () => void;
    title?: string;
}

export function CommandPalette({ commands, onClose, title }: CommandPaletteProps) {
    const { height } = useWindowDimensions();
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
        <View style={[styles.container, { maxHeight: Math.min(500, height * 0.65) }]}>
            {title !== undefined && <Text style={styles.title}>{title}</Text>}
            <CommandPaletteInput
                value={searchQuery}
                onChangeText={handleSearchChange}
                onKeyPress={handleKeyPress}
                inputRef={inputRef}
            />
            <CommandPaletteResults
                categories={filteredCategories}
                selectedIndex={selectedIndex}
                onSelectCommand={handleSelectCommand}
                onSecondaryCommand={handleSecondaryCommand}
                onSelectionChange={setSelectedIndex}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        backgroundColor: '#FFFFFF',
        borderRadius: 16,
        width: '100%',
        maxWidth: 800, // Increased from 640 for wider input
        // Use viewport-based height for better layout
        maxHeight: 500,
        overflow: 'hidden',
        shadowColor: '#000',
        shadowOffset: {
            width: 0,
            height: 20,
        },
        shadowOpacity: 0.25,
        shadowRadius: 40,
        elevation: 20,
        borderWidth: 1,
        borderColor: 'rgba(0, 0, 0, 0.08)',
    },
    title: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8, color: '#333', fontSize: 14, fontWeight: '600' },
});
