import React, { useRef, useEffect } from 'react';
import { View, ScrollView, Text, StyleSheet, Platform } from 'react-native';
import { Command, CommandCategory } from '@/components/CommandPalette/types';
import { CommandPaletteItem } from '@/components/CommandPalette/CommandPaletteItem';
import { SectionLabel, withAlpha } from '@/components/ui';
import { Typography } from '@/constants/Typography';
import { useUnistyles } from 'react-native-unistyles';
import { darkTheme } from '@/theme';

interface CommandPaletteResultsProps {
    categories: CommandCategory[];
    selectedIndex: number;
    onSelectCommand: (command: Command) => void;
    onSecondaryCommand?: (command: Command) => void;
    onSelectionChange: (index: number) => void;
    appearance?: 'terminal';
    /** Quiet line drawn above the rows (unknown kind, no search matches). */
    quietLine?: string;
}

export function CommandPaletteResults({
    categories,
    selectedIndex,
    onSelectCommand,
    onSecondaryCommand,
    onSelectionChange,
    appearance,
    quietLine,
}: CommandPaletteResultsProps) {
    const { theme: appTheme } = useUnistyles();
    const theme = appearance === 'terminal' ? darkTheme : appTheme;
    const scrollViewRef = useRef<ScrollView>(null);
    const itemRefs = useRef<{ [key: number]: View | null }>({});

    // Flatten commands for index tracking
    const allCommands = React.useMemo(() => {
        return categories.flatMap(cat => cat.commands);
    }, [categories]);

    // Scroll to selected item when index changes
    useEffect(() => {
        const selectedItem = itemRefs.current[selectedIndex];
        if (selectedItem && scrollViewRef.current) {
            // For web, we need to use the DOM API
            if (typeof (selectedItem as any).scrollIntoView === 'function') {
                (selectedItem as any).scrollIntoView({
                    behavior: 'smooth',
                    block: 'nearest',
                });
            }
        }
    }, [selectedIndex]);

    if (categories.length === 0 || allCommands.length === 0) {
        return (
            <View style={styles.emptyContainer}>
                <Text style={[styles.emptyText, { color: theme.colors.textSecondary }, Typography.default()]}>
                    No commands found
                </Text>
            </View>
        );
    }

    let currentIndex = 0;
    let shownCategories = 0;

    return (
        <ScrollView
            ref={scrollViewRef}
            style={[styles.container, appearance === 'terminal' && styles.terminalContainer]}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
        >
            {quietLine !== undefined && <Text style={[styles.quietLine, { color: theme.colors.textSecondary }, Typography.default()]}>{quietLine}</Text>}
            {categories.map(category => {
                if (category.commands.length === 0) return null;

                const categoryStartIndex = currentIndex;
                const isDestructive = category.commands.some((command) => command.destructive === true);
                const categoryCommands = category.commands.map((command, idx) => {
                    const commandIndex = categoryStartIndex + idx;
                    const isSelected = commandIndex === selectedIndex;
                    currentIndex++;

                    return (
                        <View
                            key={command.id}
                            ref={(ref) => {
                                itemRefs.current[commandIndex] = ref;
                            }}
                        >
                            {appearance === 'terminal' && idx > 0 && <View style={[styles.rowSeparator, { backgroundColor: theme.colors.divider }]} />}
                            <CommandPaletteItem
                                command={command}
                                isSelected={isSelected}
                                onPress={() => onSelectCommand(command)}
                                onSecondaryPress={() => onSecondaryCommand?.(command)}
                                onHover={() => onSelectionChange(commandIndex)}
                                appearance={appearance}
                            />
                        </View>
                    );
                });

                shownCategories++;
                return (
                    <View key={category.id}>
                        {isDestructive && shownCategories > 1 && <View style={[styles.destructiveSeparator, { backgroundColor: theme.colors.divider }]} />}
                        {category.title !== '' && <SectionLabel
                            style={[styles.categoryLabel, appearance === 'terminal' && { color: withAlpha(darkTheme.colors.textSecondary, 0.85) }]}>
                            {category.title}
                        </SectionLabel>}
                        {categoryCommands}
                    </View>
                );
            })}
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: {
        // Use viewport-based height for better proportions
        ...(Platform.OS === 'web' ? {
            maxHeight: '55vh',
        } as any : {
            maxHeight: 420, // Fallback for native
        }),
        paddingVertical: 8,
        flexShrink: 1,
    },
    terminalContainer: { paddingTop: 0 },
    quietLine: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6, fontSize: 13, lineHeight: 18 },
    rowSeparator: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
    destructiveSeparator: { height: 1, marginHorizontal: 16, marginTop: 8 },
    categoryLabel: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6 },
    emptyContainer: {
        padding: 48,
        alignItems: 'center',
    },
    emptyText: {
        fontSize: 15,
        letterSpacing: -0.2,
    },
});
