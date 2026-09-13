import * as React from 'react';
import { Pressable, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

/**
 * One back control across session, plugin, file, diff, and ordinary stack pages.
 * The 44pt target is invisible: navigation should not become the largest shape
 * on every screen merely to remain easy to hit.
 */
export function HeaderBackButton({ onPress, label = 'Back', color, style, icon = 'chevron-back', size = 20, disabled = false }: {
    onPress: () => void;
    label?: string;
    color?: string;
    style?: StyleProp<ViewStyle>;
    /** A staged form's header uses the same control for Cancel (close) and Confirm (checkmark). */
    icon?: React.ComponentProps<typeof Ionicons>['name'];
    size?: number;
    disabled?: boolean;
}) {
    const { theme } = useUnistyles();
    return (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} hitSlop={6}
            style={({ pressed }) => [{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginLeft: -8 }, style, disabled && { opacity: 0.4 }, pressed && { opacity: 0.58, transform: [{ scale: 0.97 }] }]}>
            <Ionicons name={icon} size={size} color={color ?? theme.colors.header.tint} />
        </Pressable>
    );
}
