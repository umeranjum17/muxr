import * as React from 'react';
import { Pressable, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

/**
 * Graphics that were running stopped and a tap brings them back: one line
 * at the top of the terminal, like the connection pill, never a panel over
 * the rows. The same affordance on native and on the web.
 */
export function GraphicsStoppedPill({ onRetry }: { onRetry: () => void }): React.JSX.Element {
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel="Graphics stopped. Retry terminal graphics"
            onPress={onRetry}
            hitSlop={8}
            style={({ pressed }) => ({
                position: 'absolute',
                top: 12,
                alignSelf: 'center',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 999,
                backgroundColor: '#212121',
                borderWidth: 1,
                borderColor: '#2e2e2e',
                opacity: pressed ? 0.7 : 1,
            })}
        >
            <Text style={{ color: '#9a9a9f', fontSize: 12 }}>Graphics stopped · Retry</Text>
            <Ionicons name="refresh-outline" size={12} color="#9a9a9f" />
        </Pressable>
    );
}
