import * as React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import type { Command } from '@/components/CommandPalette/types';
import { CUSTOM_CATEGORY } from '@/components/CommandPalette/types';
import { Typography } from '@/constants/Typography';
import { darkTheme } from '@/theme';

interface CommandPaletteItemProps {
    command: Command;
    isSelected: boolean;
    onPress: () => void;
    onSecondaryPress?: () => void;
    onHover?: () => void;
    appearance?: 'terminal';
}

export function CommandPaletteItem({ command, isSelected, onPress, onSecondaryPress, onHover, appearance }: CommandPaletteItemProps) {
    const { theme: appTheme } = useUnistyles();
    const theme = appearance === 'terminal' ? darkTheme : appTheme;
    const [isHovered, setIsHovered] = React.useState(false);
    const active = isSelected || isHovered;

    // Terminal command row: tap sends (the Custom row inserts a draft instead,
    // and its label says so), the pencil edits, destructive is said by its
    // section, a dot and the colour — never by a second button. The tap target
    // and the pencil are siblings, not button-in-button: react-native-web
    // refuses to nest them (validateDOMNesting) and the a11y tree follows suit.
    // The row's padding therefore lives on the tap target, which stretches to
    // the row's full height: put it back on the row and the tappable area
    // shrinks to the text while the row still paints a full-width highlight.
    const hoverIn = () => { setIsHovered(true); onHover?.(); };
    const hoverOut = () => setIsHovered(false);
    if (appearance === 'terminal') return (
        <View style={[styles.row, active && { backgroundColor: theme.colors.surfaceHighest }]}>
            <Pressable
                onPress={onPress}
                onHoverIn={hoverIn}
                onHoverOut={hoverOut}
                accessibilityRole="button"
                accessibilityLabel={command.destructive === true
                    ? `${command.title}, destructive, ${command.subtitle ?? ''}. Asks before sending.`
                    : command.category === CUSTOM_CATEGORY
                        ? `${command.title}, ${command.subtitle ?? ''}. Inserts a draft and closes.`
                        : `${command.title}, ${command.subtitle ?? ''}. Sends now.`}
                style={({ pressed }) => [styles.rowTap, pressed && { backgroundColor: theme.colors.surfacePressed }]}>
                <View style={styles.rowCopy}>
                    <View style={styles.commandLine}>
                        {command.destructive === true && <View style={[styles.destructiveDot, { backgroundColor: theme.colors.status.error }]} />}
                        <Text numberOfLines={1} style={[styles.command, { color: command.destructive === true ? theme.colors.status.error : theme.colors.text }, Typography.mono()]}>
                            {command.title}
                            {command.hint !== undefined && <Text style={[styles.hint, { color: theme.colors.textSecondary }, Typography.mono()]}> {command.hint}</Text>}
                        </Text>
                    </View>
                    {command.subtitle !== undefined && <Text numberOfLines={1} style={[styles.description, { color: theme.colors.textSecondary }, Typography.default()]}>{command.subtitle}</Text>}
                </View>
            </Pressable>
            {command.secondaryAction !== undefined && (
                <Pressable onPress={onSecondaryPress} onHoverIn={hoverIn} onHoverOut={hoverOut}
                    accessibilityRole="button" accessibilityLabel={`Edit ${command.title}`}
                    style={({ pressed }) => [styles.editTarget, pressed && { backgroundColor: theme.colors.surfacePressed }]}>
                    <Ionicons name="create-outline" size={18} color={theme.colors.textSecondary} />
                </Pressable>
            )}
        </View>
    );

    return (
        <View style={[styles.container, {
            backgroundColor: active ? theme.colors.surfaceHighest : 'transparent',
            borderColor: isSelected ? theme.colors.textSecondary : 'transparent',
        }]}>
            <Pressable
                onPress={onPress}
                onHoverIn={() => { setIsHovered(true); onHover?.(); }}
                onHoverOut={() => setIsHovered(false)}
                accessibilityRole="button"
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
    row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingRight: 16, borderRadius: 10 },
    rowTap: { flex: 1, minWidth: 0, alignSelf: 'stretch', justifyContent: 'center', paddingLeft: 16, paddingVertical: 8, borderRadius: 10 },
    rowCopy: { flex: 1, minWidth: 0 },
    commandLine: { flexDirection: 'row', alignItems: 'center' },
    destructiveDot: { width: 6, height: 6, borderRadius: 3, marginRight: 8 },
    command: { fontSize: 15, lineHeight: 20, flexShrink: 1 },
    hint: { fontSize: 15, lineHeight: 20 },
    description: { fontSize: 12, lineHeight: 16, marginTop: 2 },
    editTarget: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginLeft: 4, borderRadius: 10 },
    main: { flex: 1, minHeight: 44, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, flexDirection: 'row', alignItems: 'center' },
    iconContainer: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
    textContainer: { flex: 1, marginRight: 12 },
    title: { fontSize: 15, marginBottom: 2 },
    subtitle: { fontSize: 14, lineHeight: 20 },
    shortcutContainer: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6 },
    shortcut: { fontSize: 12 },
});
