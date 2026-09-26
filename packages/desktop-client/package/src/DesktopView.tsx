import { requireNativeView } from 'expo';
import * as React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { desktopAvailable } from './native';

export interface DesktopViewProps {
    /** The session handle from `useDesktopSession`. */
    sessionId: string | null;
    style?: StyleProp<ViewStyle>;
    /** Shown until the first desktop frame has actually rendered. */
    placeholder?: React.ReactNode;
    /** What a screen reader calls the surface. */
    accessibilityLabel?: string;
    /**
     * Space the application keeps free above the phone's keyboard for its own
     * controls, in points. While the keyboard is up the picture sits above both,
     * following the keyboard as it moves.
     */
    keyboardClearance?: number;
}

interface NativeSurfaceProps {
    sessionId: string | null;
    style?: StyleProp<ViewStyle>;
    accessible?: boolean;
    accessibilityLabel?: string;
    keyboardClearance?: number;
}

// The Expo view is resolved at module load; on a platform without it the
// component is absent and `DesktopView` falls back to its placeholder.
const NativeSurface: React.ComponentType<NativeSurfaceProps> | null = desktopAvailable
    ? (requireNativeView('Desklink', 'DesklinkSurface') as React.ComponentType<NativeSurfaceProps>)
    : null;

/**
 * The live desktop surface.
 *
 * It renders the picture and the pointer and owns the gestures, and nothing
 * else: the surrounding chrome, the start state and the return navigation
 * belong to the application, which mounts this wherever it wants the desktop
 * to appear.
 */
export function DesktopView({ sessionId, style, placeholder, accessibilityLabel, keyboardClearance = 0 }: DesktopViewProps) {
    if (NativeSurface == null || sessionId == null) {
        return (
            <View style={[styles.surface, style]}>
                {placeholder}
            </View>
        );
    }
    return <NativeSurface style={[styles.surface, style]} sessionId={sessionId} accessible={accessibilityLabel !== undefined} accessibilityLabel={accessibilityLabel} keyboardClearance={keyboardClearance} />;
}

const styles = StyleSheet.create({
    surface: {
        backgroundColor: '#000',
        overflow: 'hidden',
    },
});
