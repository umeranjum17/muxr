/**
 * Grid view for one herdr tab: every pane of the split layout as a live tile.
 * The multiplexing payoff -- see PaneGridView.
 */

import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { sync } from '@/catalog/sync';
import { PaneGridView } from '@/herd/ui';

export default React.memo(() => {
    const route = useRoute();
    const tabId = (route.params as { tabId?: string } | undefined)?.tabId ?? '';
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();

    // Zoom ladder: pinch closed here goes one level further out, to the
    // workspace overview (all tabs with their panes).
    const [workspaceId, setWorkspaceId] = React.useState<string | null>(null);
    React.useEffect(() => {
        void sync
            .request('herdr.tree', {})
            .then((tree) => {
                const owner = tree.workspaces.find((workspace) => workspace.tabs.some((tab) => tab.tabId === tabId));
                setWorkspaceId(owner?.workspaceId ?? null);
            })
            .catch(() => undefined);
    }, [tabId]);
    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background, paddingTop: insets.top }}>
            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    backgroundColor: theme.colors.surface,
                }}
            >
                <Pressable onPress={() => router.back()} hitSlop={12}>
                    <Ionicons name="chevron-back" size={22} color={theme.colors.text} />
                </Pressable>
                <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={{ color: theme.colors.text, fontWeight: '600' }}>
                        {tabId === '' ? 'Tab' : tabId}
                    </Text>
                    <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 12 }}>
                        all panes
                    </Text>
                </View>
                {workspaceId === null ? null : (
                    <Pressable onPress={() => router.push(`/workspace/${encodeURIComponent(workspaceId)}`)} hitSlop={12} accessibilityLabel="Workspace">
                        <Ionicons name="albums-outline" size={20} color={theme.colors.text} />
                    </Pressable>
                )}
            </View>
            {tabId === '' ? null : <PaneGridView tabId={tabId} />}
        </View>
    );
});
