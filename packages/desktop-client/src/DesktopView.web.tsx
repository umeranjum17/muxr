import * as React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { attachSurface, desktopAvailable } from './native';

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
 * The picture, the gestures and the keyboard all belong to the session's own
 * web implementation, so this is a mount point: it hands the session a DOM
 * element and gets out of the way. Everything the surrounding application does
 * — where the surface sits, the start state, the return — is unchanged from
 * native, which is the point of putting the platform difference here.
 */
export function DesktopView({ sessionId, style, placeholder }: DesktopViewProps) {
    const mounted = React.useCallback(
        (node: unknown) => {
            if (sessionId === null || !desktopAvailable) return;
            attachSurface(sessionId, (node as HTMLElement | null) ?? null);
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
