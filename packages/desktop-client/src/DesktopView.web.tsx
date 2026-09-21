import * as React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

export interface DesktopViewProps {
    /** The session handle from `useDesktopSession`. */
    sessionId: string | null;
    style?: StyleProp<ViewStyle>;
    /** Shown until the first desktop frame has actually rendered. */
    placeholder?: React.ReactNode;
}

/**
 * The live desktop surface, in a browser.
 *
 * The picture, the gestures and the keyboard belong to the session's own web
 * implementation, so this is a mount point: it hands that session a DOM element
 * and gets out of the way. The platform module is imported when a surface is
 * actually mounted rather than at module load, so an application that never
 * opens a desktop does not carry one in its first paint.
 */
export function DesktopView({ sessionId, style, placeholder }: DesktopViewProps) {
    const mounted = React.useCallback(
        (node: unknown) => {
            const element = (node as HTMLElement | null) ?? null;
            if (sessionId === null) return;
            void import('./native').then((platform) => {
                if (element === null || !platform.desktopAvailable) return;
                platform.attachSurface(sessionId, element);
            });
        },
        [sessionId],
    );

    return (
        <View style={[styles.surface, style]}>
            {sessionId === null ? placeholder : <div ref={mounted} style={styles.dom} />}
        </View>
    );
}

const styles = StyleSheet.create({
    surface: { backgroundColor: '#000', overflow: 'hidden' },
    dom: { position: 'absolute', inset: 0 },
});
