import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SvgXml } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import type { Theme } from '@/theme';
import type { PluginItemMetadata } from '@/plugins/domain/itemListModel';
import { toneColor } from '@/plugins/domain/pluginTone';

/**
 * The command panel is its own overlay surface in the selected design, with a
 * palette that does not follow the app's chrome tokens: a white (not raised
 * grey) card, slate rather than pure-black text, and the darker signed totals
 * that stay legible on white.
 */
export function panelPalette(theme: Theme) {
    return theme.dark
        ? { surface: '#1e2024', text: '#f5f5f7', secondary: '#a1a1aa', divider: '#2a2d33', border: 'rgba(255,255,255,0.10)', pressed: '#2a2d33', positive: '#4ade80', danger: '#f87171', keyFill: '#f5f5f7', keyTint: '#111318' }
        : { surface: '#ffffff', text: '#111827', secondary: '#6b7280', divider: '#e5e7eb', border: 'rgba(0,0,0,0.08)', pressed: '#f0f0f2', positive: '#15803d', danger: '#b91c1c', keyFill: '#111827', keyTint: '#ffffff' };
}

// The design's own glyphs, verbatim, so the panel's icon weight is the
// reference's 1.9 stroke rather than whatever the icon set ships.
const GLYPHS = {
    keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/>',
    minus: '<path d="M5 12h14"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    reset: '<path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v5h5"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    command: '<path d="M18 8a3 3 0 1 0-3-3v14a3 3 0 1 0 3-3H5a3 3 0 1 0 3 3V5a3 3 0 1 0-3 3Z"/>',
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M18 11c0 3-4 3-7 4-2 .6-3 1.5-3 3"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    tools: '<path d="M14.5 6.5a4 4 0 0 0 5 5L9 22l-3-3L16.5 8.5a4 4 0 0 1-2-2z"/><path d="M14.5 6.5L18 3l3 3-3.5 3.5"/>',
} as const;
export type PanelGlyphName = keyof typeof GLYPHS;

/** Icon-set names that the design draws itself. Names, never plugin ids. */
const DESIGN_GLYPH: Record<string, PanelGlyphName> = {
    'git-branch-outline': 'branch', 'git-branch': 'branch',
    'git-compare-outline': 'branch', 'git-compare': 'branch',
    'git-network-outline': 'branch', 'git-network': 'branch',
    'folder-outline': 'folder', 'folder': 'folder', 'folder-open-outline': 'folder',
    'construct-outline': 'tools', 'construct': 'tools',
    'build-outline': 'tools', 'build': 'tools',
    'hammer-outline': 'tools', 'hammer': 'tools',
};

export const PanelGlyph = React.memo(function PanelGlyph({ name, color, size = 24 }: { name: PanelGlyphName; color: string; size?: number }) {
    return <SvgXml width={size} height={size} color={color}
        xml={`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[name]}</svg>`} />;
});

/** The design's glyph for an icon-set name, or that icon set's own drawing. */
export function PanelIcon({ icon, color, size = 24 }: { icon: string; color: string; size?: number }) {
    const glyph = DESIGN_GLYPH[icon];
    if (glyph !== undefined) return <PanelGlyph name={glyph} color={color} size={size} />;
    return <Ionicons name={icon as never} size={size} color={color} />;
}

/**
 * One full-width labelled quick-action row: a fixed icon column and label that
 * never move, with the action's data confined to the trailing column so row
 * width no longer depends on the values. The plain count is a secondary line,
 * never a badge over the icon.
 */
export function ActionShortcut({ label, accessibilityLabel = label, icon, badge, metadata, disabled = false, onPress }: {
    label: string;
    accessibilityLabel?: string;
    icon: React.ComponentProps<typeof Ionicons>['name'];
    /** Plain count; under the metadata values when both exist. */
    badge?: string | number;
    metadata?: readonly PluginItemMetadata[];
    disabled?: boolean;
    onPress: () => void;
}) {
    const { theme } = useUnistyles();
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
            paddingHorizontal: 10, borderRadius: 10,
            backgroundColor: pressed ? panel.pressed : 'transparent',
            opacity: disabled ? 0.4 : 1,
        })}>
        <View style={{ width: 24, height: 24, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}>
            <PanelIcon icon={icon} color={panel.text} />
        </View>
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
