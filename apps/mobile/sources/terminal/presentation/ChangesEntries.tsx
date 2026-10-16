import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

/**
 * The agent's uncommitted changes, findable without the quick-actions ring:
 * a count pill in the header's identity row and a Changes row in Pane actions,
 * both opening the session's existing changes review. The ring keeps its own
 * slot; the menu filters it out so only one Changes row ever shows.
 *
 * The pill lives inside the existing title row — a row of its own that appears
 * late would change the header's height and re-attach the terminal. The title
 * shrinks first; the pill holds one line and truncates at its cap.
 */

function changesLabel(count: number): string {
    return t('turnChanges.filesChanged', { count });
}

function hasChanges(count: number | null): count is number {
    return count !== null && count > 0;
}

export function HeaderChangesPill({ count, onPress }: { count: number | null; onPress: () => void }) {
    const { theme } = useUnistyles();
    if (!hasChanges(count)) return null;
    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={`Review changes, ${changesLabel(count)}`}
            hitSlop={6}
            style={({ pressed }) => ({ flexShrink: 0, maxWidth: '42%', opacity: pressed ? 0.6 : 1, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, overflow: 'hidden' })}>
            <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 11, fontWeight: '500' }}>{changesLabel(count)}</Text>
        </Pressable>
    );
}

export function PaneActionsChangesRow({ count, onPress }: { count: number | null; onPress: () => void }) {
    const { theme } = useUnistyles();
    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={`Review changes${hasChanges(count) ? `, ${changesLabel(count)}` : ''}`}
            style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
            <Ionicons name="git-compare-outline" size={18} color={theme.colors.textSecondary} />
            <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>Changes</Text>
            {hasChanges(count) && <View style={{ minWidth: 24, height: 22, paddingHorizontal: 7, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceHighest }}>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 11, fontWeight: '600' }}>{count}</Text>
            </View>}
            <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
        </Pressable>
    );
}
