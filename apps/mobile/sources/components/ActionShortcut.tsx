import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { UnistylesRuntime, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import type { Theme } from '@/theme';
import type { PluginItemMetadata } from '@/plugins/domain/itemListModel';
import { toneColor } from '@/plugins/domain/pluginTone';

/**
 * The panel's ink and surfaces, one mapping from the theme in force. Over the
 * terminal that theme is the dark one, applied by the sheet's own scope.
 */
export function panelPalette(theme: Theme) {
    return theme.dark
        ? { surface: '#1e2024', text: '#f5f5f7', secondary: '#a1a1aa', divider: '#2a2d33', border: 'rgba(255,255,255,0.10)', pressed: '#2a2d33', positive: '#4ade80', danger: '#f87171', keyFill: '#f5f5f7', keyTint: '#111318' }
        : { surface: '#ffffff', text: '#111827', secondary: '#6b7280', divider: '#e5e7eb', border: 'rgba(0,0,0,0.08)', pressed: '#f0f0f2', positive: '#15803d', danger: '#b91c1c', keyFill: '#111827', keyTint: '#ffffff' };
}

/** Names the terminal's own commands use for their glyphs; rows show the label. */
export type PanelGlyphName = 'keyboard' | 'minus' | 'plus' | 'reset' | 'close' | 'branch' | 'folder' | 'tools';

/**
 * One full-width labelled quick-action row: the label leads and never moves,
 * with the action's data confined to the trailing column so row width never
 * depends on the values. Rows carry no glyph: the panel's items come from
 * several plugins with several icon registers, and a list of plain words
 * reads as one thing where four mismatched drawings do not.
 */
export function ActionShortcut({ label, accessibilityLabel = label, badge, metadata, disabled = false, onPress }: {
    label: string;
    accessibilityLabel?: string;
    /** Accepted for callers that declare one; never drawn. */
    icon?: React.ComponentProps<typeof Ionicons>['name'] | string;
    /** Plain count; under the metadata values when both exist. */
    badge?: string | number;
    metadata?: readonly PluginItemMetadata[];
    disabled?: boolean;
    onPress: () => void;
}) {
    // Panel rows mount late (a plugin list resolving) outside any scope's
    // render pass, so the row names its register itself: the terminal's
    // dark theme, whatever the app is set to. Subscribed for re-renders.
    useUnistyles();
    const theme = UnistylesRuntime.getTheme('dark');
    const panel = panelPalette(theme);
    const hasMetadata = metadata !== undefined && metadata.length > 0;
    const metadataLabel = metadata?.map((entry) => entry.label === undefined ? entry.value : `${entry.label} ${entry.value}`).join(', ');
    const metadataColor = (tone: PluginItemMetadata['tone']): string => {
        if (tone === 'positive') return panel.positive;
        if (tone === 'danger') return panel.danger;
        return toneColor(theme, tone);
    };
    return <Pressable accessibilityRole="button" accessibilityLabel={hasMetadata ? `${accessibilityLabel}, ${metadataLabel}` : accessibilityLabel}
        accessibilityState={{ disabled }} accessibilityValue={badge === undefined ? undefined : { text: String(badge) }}
        disabled={disabled} onPress={onPress}
        style={({ pressed }) => ({
            minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12,
            paddingHorizontal: 14, borderRadius: 10,
            backgroundColor: pressed ? panel.pressed : 'transparent',
            opacity: disabled ? 0.4 : 1,
        })}>
        {/* Label wraps to a second line instead of ellipsizing: at large font
            sizes a truncated title hides the row's whole point. */}
        <Text style={{ flex: 1, flexShrink: 1, color: panel.text, fontSize: 15, lineHeight: 20, ...Typography.mono('regular') }}>{label}</Text>
        {/* The column is bounded so a long metadata run can never starve the
            label the way the native capture showed it doing. */}
        {(hasMetadata || badge !== undefined) && <View style={{ alignItems: 'flex-end', flexShrink: 1, maxWidth: '55%' }}>
            {/* Values carry the sign visually; labels stay in accessibility
                text. Entries wrap onto the next line rather than clipping: a
                signed total cut mid-number is unreadable at small widths. */}
            {hasMetadata && <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }}>
                {metadata.map((entry, index) => <Text key={index} accessible={false}
                    style={{ color: metadataColor(entry.tone), fontSize: 14, lineHeight: 17, ...Typography.mono('semiBold') }}>{entry.value}</Text>)}
            </View>}
            {badge !== undefined && <Text accessible={false} style={{ color: panel.secondary, fontSize: 12, lineHeight: 15, ...Typography.mono('regular') }}>{badge}</Text>}
        </View>}
    </Pressable>;
}
