import * as React from 'react';
import { Pressable, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

/**
 * One back control across session, plugin, file, diff, and ordinary stack pages.
 * The 44pt target is invisible: navigation should not become the largest shape
 * on every screen merely to remain easy to hit.
 */
export function HeaderBackButton({ onPress, label = 'Back', color, style }: { onPress: () => void; label?: string; color?: string; style?: StyleProp<ViewStyle> }) {
    const { theme } = useUnistyles();
    return (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={6}
            style={({ pressed }) => [{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginLeft: -8 }, style, pressed && { opacity: 0.58, transform: [{ scale: 0.97 }] }]}>
            <Ionicons name="chevron-back" size={20} color={color ?? theme.colors.header.tint} />
        </Pressable>
    );
}
