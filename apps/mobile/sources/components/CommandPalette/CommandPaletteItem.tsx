import * as React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import type { Command } from '@/components/CommandPalette/types';
import { Typography } from '@/constants/Typography';
import { darkTheme } from '@/theme';

interface CommandPaletteItemProps {
    command: Command;
    isSelected: boolean;
    onPress: () => void;
    onSecondaryPress?: () => void;
    onHover?: () => void;
    appearance?: 'terminal';
    compact?: boolean;
}

export function CommandPaletteItem({ command, isSelected, onPress, onSecondaryPress, onHover, appearance, compact }: CommandPaletteItemProps) {
    const { theme: appTheme } = useUnistyles();
    const theme = appearance === 'terminal' ? darkTheme : appTheme;
    const [isHovered, setIsHovered] = React.useState(false);
    const active = isSelected || isHovered;
    const rowStyle = [styles.container, {
        backgroundColor: active ? theme.colors.surfaceHighest : 'transparent',
        borderColor: isSelected ? theme.colors.textSecondary : 'transparent',
    }];
    const hoverProps = {
        onHoverIn: () => { setIsHovered(true); onHover?.(); },
        onHoverOut: () => setIsHovered(false),
    };

    if (command.secondaryAction !== undefined) return (
        <View style={[rowStyle, styles.agentContainer, compact && styles.compactAgentContainer]}>
            <Text numberOfLines={1} style={[styles.agentTitle, { color: theme.colors.text }, Typography.mono()]}>{command.title}</Text>
            {command.subtitle && <Text numberOfLines={2} style={[styles.agentSubtitle, compact && styles.compactAgentSubtitle, { color: theme.colors.textSecondary }, Typography.default()]}>{command.subtitle}</Text>}
            <View style={[styles.agentActions, compact && styles.compactAgentActions]}>
                <Pressable {...hoverProps} onPress={onPress} accessibilityRole="button"
                    accessibilityLabel={`Send now: ${command.title}. ${command.subtitle ?? ''}`}
                    style={({ pressed }) => [styles.sendButton, { backgroundColor: theme.colors.button.primary.background, opacity: pressed ? 0.72 : 1 }]}>
                    <Text style={[styles.actionText, { color: theme.colors.button.primary.tint }, Typography.default('semiBold')]}>Send now</Text>
                </Pressable>
                <Pressable {...hoverProps} onPress={onSecondaryPress} accessibilityRole="button"
                    accessibilityLabel={`${command.secondaryLabel ?? 'Edit arguments'} for ${command.title}`}
                    style={({ pressed }) => [styles.editButton, { backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh, borderColor: theme.colors.divider }]}>
                    <Ionicons name="create-outline" size={17} color={theme.colors.text} />
                    <Text style={[styles.actionText, { color: theme.colors.text }, Typography.default('semiBold')]}>{command.secondaryLabel ?? 'Edit'}</Text>
                </Pressable>
            </View>
        </View>
    );

    return (
        <View style={rowStyle}>
            <Pressable {...hoverProps} onPress={onPress} accessibilityRole="button"
                accessibilityLabel={`${command.title}. ${command.subtitle ?? ''}. ${command.actionLabel ?? 'Open'}`}
                style={({ pressed }) => [styles.main, pressed && { backgroundColor: theme.colors.surfacePressed }]}>
                {command.icon && <View style={[styles.iconContainer, { backgroundColor: theme.colors.surfaceHigh }]}>
                    <Ionicons name={command.icon as never} size={20} color={theme.colors.textSecondary} />
                </View>}
                <View style={styles.textContainer}>
                    <Text style={[styles.title, { color: theme.colors.text }, Typography.default()]}>{command.title}</Text>
                    {command.subtitle && <Text style={[styles.subtitle, { color: theme.colors.textSecondary }, Typography.default()]}>{command.subtitle}</Text>}
                </View>
                {command.shortcut && <View style={[styles.shortcutContainer, { backgroundColor: theme.colors.surfaceHigh }]}>
                    <Text style={[styles.shortcut, { color: theme.colors.textSecondary }, Typography.mono()]}>{command.shortcut}</Text>
                </View>}
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create({
    container: { marginHorizontal: 8, marginVertical: 3, borderRadius: 12, borderWidth: 1, borderLeftWidth: 3 },
    agentContainer: { paddingHorizontal: 14, paddingVertical: 12 },
    compactAgentContainer: { paddingVertical: 8 },
    agentTitle: { fontSize: 15, lineHeight: 22 },
    agentSubtitle: { fontSize: 14, lineHeight: 20, marginTop: 3 },
    compactAgentSubtitle: { lineHeight: 18 },
    agentActions: { flexDirection: 'row', gap: 8, marginTop: 12 },
    compactAgentActions: { marginTop: 8 },
    sendButton: { flex: 1, minHeight: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
    editButton: { flex: 1, minHeight: 40, borderRadius: 9, borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
    actionText: { fontSize: 14 },
    main: { flex: 1, minHeight: 44, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, flexDirection: 'row', alignItems: 'center' },
    iconContainer: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
    textContainer: { flex: 1, marginRight: 12 },
    title: { fontSize: 15, marginBottom: 2 },
    subtitle: { fontSize: 14, lineHeight: 20 },
    shortcutContainer: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6 },
    shortcut: { fontSize: 12 },
});
