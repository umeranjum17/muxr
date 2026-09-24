/**
 * One herdr tab's split as a mini-map, for existing links: the same renderer
 * the session header's pane overview uses, on its own route.
 */

import * as React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { sync } from '@/catalog/sync';
import { useHerdrTree } from '@/catalog/store';
import { tabLabel, useNavigateToSession } from '@/herd';
import { PaneMap } from '@/herd/ui';

export default React.memo(() => {
    const route = useRoute();
    const tabId = (route.params as { tabId?: string } | undefined)?.tabId ?? '';
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const { workspaces, loaded } = useHerdrTree();
    const navigate = useNavigateToSession();
    React.useEffect(() => { void sync.refreshHerdTree().catch(() => undefined); }, [tabId]);
    const owner = workspaces.find((workspace) => workspace.tabs.some((tab) => tab.tabId === tabId));
    const tab = owner?.tabs.find((entry) => entry.tabId === tabId);
    const title = owner === undefined || tab === undefined ? 'Panes' : tabLabel(tab, owner.tabs.indexOf(tab));
    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background, paddingTop: insets.top }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: theme.colors.surface }}>
                <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back">
                    <Ionicons name="chevron-back" size={22} color={theme.colors.text} />
                </Pressable>
                <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={{ color: theme.colors.text, fontWeight: '600' }}>{title}</Text>
                    <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 12 }}>all panes</Text>
                </View>
                {owner !== undefined && (
                    <Pressable onPress={() => router.push(`/workspace/${encodeURIComponent(owner.workspaceId)}`)} hitSlop={12} accessibilityRole="button" accessibilityLabel="Workspace">
                        <Ionicons name="albums-outline" size={20} color={theme.colors.text} />
                    </Pressable>
                )}
            </View>
            <ScrollView contentContainerStyle={{ padding: 16 }}>
                {tab === undefined || tab.panes.length === 0
                    ? <Text style={{ color: theme.colors.textSecondary, textAlign: 'center', paddingVertical: 32 }}>{loaded ? 'No panes in this tab' : 'Loading panes…'}</Text>
                    : <PaneMap tab={tab} canClose={false} onOpen={(pane) => { if (pane.sessionId !== undefined) navigate(pane.sessionId); }} onClose={() => undefined} />}
            </ScrollView>
        </View>
    );
});
