import { requireNativeView } from 'expo';
import * as React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { desktopAvailable } from './native';

export interface DesktopViewProps {
    /** The native session handle from `useDesktopSession`. */
    sessionId: string | null;
    style?: StyleProp<ViewStyle>;
    /** Shown until the first desktop frame has actually rendered. */
    placeholder?: React.ReactNode;
}

interface NativeSurfaceProps {
    sessionId: string | null;
    style?: StyleProp<ViewStyle>;
}

// The Expo view is resolved at module load; on a platform without it the
// component is absent and `DesktopView` falls back to its placeholder.
const NativeSurface: React.ComponentType<NativeSurfaceProps> | null = desktopAvailable
    ? (requireNativeView('Desklink', 'DesklinkSurface') as React.ComponentType<NativeSurfaceProps>)
    : null;

/**
 * The live desktop surface.
 *
 * It renders the picture and owns the gestures, and nothing else: the
 * surrounding chrome, the start state and the return navigation belong to the
 * application, which mounts this wherever it wants the desktop to appear.
 */
export function DesktopView({ sessionId, style, placeholder }: DesktopViewProps) {
    if (NativeSurface == null || sessionId == null) {
        return (
            <View style={[styles.surface, style]}>
                {placeholder}
            </View>
        );
    }
    return <NativeSurface style={[styles.surface, style]} sessionId={sessionId} />;
}

const styles = StyleSheet.create({
    surface: {
        backgroundColor: '#000',
        overflow: 'hidden',
    },
});
