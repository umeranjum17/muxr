/**
 * One herdr tab's panes as cards, for existing links: the same renderer the
 * session header's pane overview uses, on its own route.
 */

import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { sync } from '@/catalog/sync';
import { useHerdrTree } from '@/catalog/store';
import { useDeviceAuthority } from '@/pairing';
import { tabLabel, useNavigateToSession } from '@/herd';
import { PaneGridView } from '@/herd/ui';

export default React.memo(() => {
    const route = useRoute();
    const tabId = (route.params as { tabId?: string } | undefined)?.tabId ?? '';
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const { workspaces, loaded } = useHerdrTree();
    const { authority, loading } = useDeviceAuthority();
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
            <PaneGridView
                panes={tab?.panes ?? []}
                canClose={false}
                closeReason={authority === 'control' && !loading ? 'Close panes from the session' : 'View-only devices cannot close panes'}
                onOpen={(pane) => { if (pane.sessionId !== undefined) navigate(pane.sessionId); }}
                onClose={() => undefined}
                emptyText={loaded ? 'No panes in this tab' : 'Loading panes…'}
            />
        </View>
    );
});
