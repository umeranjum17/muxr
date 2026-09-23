import * as React from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions, type TextStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { BaseModal } from '@/modal/components/BaseModal';
import { Typography } from '@/constants/Typography';
import { hapticsSelection } from '@/components/haptics';

export interface Choice {
    key: string;
    label: string;
    /** The choice drawn as itself: a font in its own face, a size at its size. */
    labelStyle?: TextStyle;
    detail?: string;
    /** A miniature of the choice (a theme swatch, an avatar) before the label. */
    preview?: React.ReactNode;
}

/**
 * A compact card for picking one value of a setting. Every option renders as
 * what it is, and the current one carries the accent and a check. Picking
 * closes the card: the row it came from already shows the new value.
 */
export function ChoiceSheet({ visible, title, choices, selectedKey, onSelect, onClose }: {
    visible: boolean;
    title: string;
    choices: readonly Choice[];
    selectedKey: string;
    onSelect: (key: string) => void;
    onClose: () => void;
}) {
    const { theme } = useUnistyles();
    const { width, height } = useWindowDimensions();
    return (
        <BaseModal visible={visible} onClose={onClose}>
            <View
                accessibilityRole="radiogroup"
                accessibilityLabel={title}
                style={[styles.card, { width: Math.min(width - 48, 360), maxHeight: height - 96 }]}
            >
                <Text style={styles.title} accessibilityRole="header">{title}</Text>
                <ScrollView bounces={false} showsVerticalScrollIndicator={false}>
                    {choices.map((choice) => {
                        const selected = choice.key === selectedKey;
                        const tint = selected ? theme.colors.textLink : theme.colors.text;
                        return (
                            <Pressable
                                key={choice.key}
                                accessibilityRole="radio"
                                accessibilityState={{ checked: selected }}
                                accessibilityLabel={choice.detail === undefined ? choice.label : `${choice.label}, ${choice.detail}`}
                                onPress={() => {
                                    hapticsSelection();
                                    if (!selected) onSelect(choice.key);
                                    onClose();
                                }}
                                style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.colors.surfacePressed }]}
                            >
                                {choice.preview !== undefined && <View aria-hidden>{choice.preview}</View>}
                                <View style={styles.copy}>
                                    <Text style={[styles.label, choice.labelStyle, { color: tint }]} numberOfLines={1}>{choice.label}</Text>
                                    {choice.detail !== undefined && <Text style={styles.detail} numberOfLines={1}>{choice.detail}</Text>}
                                </View>
                                {selected && <Ionicons name="checkmark" size={20} color={theme.colors.textLink} />}
                            </Pressable>
                        );
                    })}
                </ScrollView>
            </View>
        </BaseModal>
    );
}

const styles = StyleSheet.create((theme) => ({
    card: {
        backgroundColor: theme.colors.surface,
        borderRadius: 22,
        paddingTop: 20,
        paddingBottom: 10,
        overflow: 'hidden',
        borderWidth: theme.dark ? StyleSheet.hairlineWidth : 0,
        borderColor: theme.colors.divider,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 18,
        color: theme.colors.text,
        paddingHorizontal: 24,
        paddingBottom: 8,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        minHeight: 52,
        paddingVertical: 10,
        paddingHorizontal: 24,
    },
    copy: {
        flex: 1,
        minWidth: 0,
    },
    label: {
        ...Typography.default(),
        fontSize: 17,
    },
    detail: {
        ...Typography.default(),
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginTop: 1,
    },
}));
