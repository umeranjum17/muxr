import * as React from 'react';
import { Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';

/**
 * The solid band behind a system bar for a screen that draws under it.
 *
 * Top inset padding inside scroll content scrolls away with the content, so
 * scrolled headings end up under the transparent status bar and the clock.
 * This band lives outside the scroll view, so scrolled content slides under
 * paint: the screen background at the top, the same at the bottom above the
 * gesture bar. Every full-bleed scrolling screen renders it instead of
 * padding its scroll content with the top inset.
 *
 * Screens whose scroll view starts below a header do not need it: their
 * viewport already clips below the header.
 */
export function SystemBarBackdrop({ edge, color }: { edge: 'top' | 'bottom'; color?: string }) {
    const insets = useSafeAreaInsets();
    const { theme } = useUnistyles();
    const height = edge === 'top' ? insets.top : insets.bottom;
    if (height <= 0) return null;
    return (
        <View
            style={{
                height,
                backgroundColor: color ?? (Platform.OS === 'web' ? theme.colors.surface : theme.colors.groupped.background),
            }}
        />
    );
}
