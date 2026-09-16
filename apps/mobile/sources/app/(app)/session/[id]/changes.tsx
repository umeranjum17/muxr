import React from 'react';
import { ScrollView, View, Text, Pressable } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { Modal } from '@/modal';
import { useSession } from '@/catalog/store';
import { changesBrowse, changesWorktrees } from '@/catalog/ops';
import { openFileViewer, recordFileNavigation } from '@/plugins/application/fileNavigationList';

type ChangesBrowse = Awaited<ReturnType<typeof changesBrowse>>;
type ChangesScope = NonNullable<Parameters<typeof changesBrowse>[1]>['scope'];
type ChangesFile = ChangesBrowse['files'][number];
type ChangesWorktrees = Awaited<ReturnType<typeof changesWorktrees>>;

/**
 * The session's working-tree review: scoped file lists over host-run git.
 * Product surface (the review half of the extracted Code add-on); the
 * session cwd never travels from the client — the host injects it.
 */
export default function ChangesScreen() {
    const router = useRouter();
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();
    const session = useSession(sessionId);
    const { theme } = useUnistyles();
    const [scope, setScope] = React.useState<ChangesScope>('working');
    const [root, setRoot] = React.useState<string | undefined>(undefined);
    const [page, setPage] = React.useState(0);
    const [browse, setBrowse] = React.useState<ChangesBrowse | undefined>(undefined);
    const [worktrees, setWorktrees] = React.useState<ChangesWorktrees | undefined>(undefined);
    const [pickingWorktree, setPickingWorktree] = React.useState(false);
    const [error, setError] = React.useState<string | undefined>(undefined);

    React.useEffect(() => {
        let cancelled = false;
        changesBrowse(sessionId, { scope, page, ...(root === undefined ? {} : { root }) })
            .then((result) => {
                if (cancelled) return;
                setBrowse(result);
                setError(undefined);
            })
            .catch((cause: unknown) => {
                if (cancelled) return;
                setError(cause instanceof Error ? cause.message : String(cause));
            });
        return () => { cancelled = true; };
    }, [sessionId, scope, page, root]);

    const pickWorktree = React.useCallback(() => {
        if (worktrees !== undefined) { setPickingWorktree((open) => !open); return; }
        changesWorktrees(sessionId)
            .then((result) => {
                setWorktrees(result);
                setPickingWorktree(true);
            })
            .catch((cause: unknown) => Modal.alert('Changes', cause instanceof Error ? cause.message : String(cause)));
    }, [sessionId, worktrees]);

    const openFile = React.useCallback((file: ChangesFile) => {
        const absolute = file.path.startsWith('/') ? file.path : `${browse?.root ?? ''}/${file.path}`;
        if (file.openable) {
            const navKey = recordFileNavigation({
                sessionId,
                sourceKey: 'muxr.changes\0review',
                selectedPath: absolute,
                items: (browse?.files ?? [])
                    .filter((entry) => entry.openable)
                    .map((entry) => ({
                        id: entry.path,
                        title: entry.title,
                        metadata: [{ value: entry.added === '-' ? 'binary' : `+${entry.added} / −${entry.deleted}` }],
                        action: { type: 'kernel.navigate', target: 'file', path: entry.path.startsWith('/') ? entry.path : `${browse?.root ?? ''}/${entry.path}` },
                    })),
            });
            router.push(openFileViewer({ sessionId, path: absolute, ...(navKey === undefined ? {} : { navigation: { key: navKey } }) }));
            return;
        }
        router.push({
            pathname: '/session/[id]/changes/file',
            params: {
                id: sessionId,
                path: file.path,
                ...(root === undefined ? {} : { root }),
                scope,
                ...(file.kind === 'working' ? {} : { kind: file.kind }),
                ...(browse === undefined ? {} : { head: browse.head, base: browse.base }),
            },
        });
    }, [browse, root, router, scope, sessionId]);

    const scopeButton = (id: ChangesScope, label: string) => (
        <Pressable
            key={id}
            accessibilityRole="button"
            accessibilityLabel={`Scope: ${label}`}
            accessibilityState={{ selected: scope === id }}
            onPress={() => { setScope(id); setPage(0); }}
            style={[styles.scopeButton, { backgroundColor: scope === id ? theme.colors.surfacePressed : 'transparent' }]}
        >
            <Text style={{ color: scope === id ? theme.colors.text : theme.colors.textSecondary, fontSize: 13, fontWeight: scope === id ? '600' : '400' }}>{label}</Text>
        </Pressable>
    );

    const scopeNote = browse === undefined ? undefined : (browse.note.split('\n')[2] ?? undefined);

    return (
        <>
            <Stack.Screen options={{ title: browse?.title ?? 'Changes' }} />
            <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
                <View style={styles.scopeRow}>
                    {scopeButton('working', 'Working')}
                    {scopeButton('staged', 'Staged')}
                    {scopeButton('branch', 'Branch')}
                    <Pressable accessibilityRole="button" accessibilityLabel="Choose worktree" onPress={pickWorktree} hitSlop={6}>
                        <Ionicons name="git-network-outline" size={18} color={theme.colors.textSecondary} />
                    </Pressable>
                </View>

                {error !== undefined && (
                    <ItemGroup>
                        <Item title="Changes unavailable" subtitle={error} icon={<Ionicons name="alert-circle-outline" size={20} color={theme.colors.textSecondary} />} />
                    </ItemGroup>
                )}

                {browse !== undefined && error === undefined && (
                    <>
                        {browse.summary.length > 0 && (
                            <View style={styles.summaryRow}>
                                {browse.summary.map((entry) => (
                                    <View key={entry.label} style={styles.summaryCell}>
                                        <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>{entry.label}</Text>
                                        <Text style={{
                                            fontSize: 17, fontWeight: '700',
                                            color: entry.tone === 'positive' ? theme.colors.gitAddedText : theme.colors.gitRemovedText,
                                        }}>{entry.value}</Text>
                                    </View>
                                ))}
                                <View style={styles.summaryCell}>
                                    <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>Files</Text>
                                    <Text style={{ color: theme.colors.text, fontSize: 17, fontWeight: '700' }}>{browse.count}</Text>
                                </View>
                            </View>
                        )}

                        {pickingWorktree && worktrees !== undefined && (
                            <ItemGroup title="Choose worktree">
                                {worktrees.worktrees.map((entry) => (
                                    <Item
                                        key={entry.root}
                                        title={entry.title}
                                        subtitle={entry.root}
                                        selected={root === undefined ? entry.sessionCheckout : entry.root === root}
                                        icon={<Ionicons name="git-branch-outline" size={18} color={theme.colors.textSecondary} />}
                                        onPress={() => {
                                            setRoot(entry.sessionCheckout && root === undefined ? undefined : entry.root);
                                            setPage(0);
                                            setPickingWorktree(false);
                                        }}
                                    />
                                ))}
                            </ItemGroup>
                        )}

                        <ItemGroup>
                            {browse.files.map((file) => (
                                <Item
                                    key={`${file.kind}:${file.path}`}
                                    title={file.title}
                                    subtitle={file.path}
                                    subtitleLines={1}
                                    icon={<Ionicons
                                        name={file.kind === 'untracked' ? 'add-circle-outline' : 'git-compare-outline'}
                                        size={18}
                                        color={theme.colors.textSecondary}
                                    />}
                                    rightElement={<Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>
                                        {file.added === '-' ? 'binary' : `+${file.added} / −${file.deleted}`}
                                    </Text>}
                                    onPress={() => openFile(file)}
                                    accessibilityLabel={`Review ${file.path}`}
                                />
                            ))}
                            {browse.files.length === 0 && (
                                <Item title="No changes" subtitle={scopeNote} icon={<Ionicons name="checkmark-circle-outline" size={20} color={theme.colors.textSecondary} />} />
                            )}
                        </ItemGroup>

                        {browse.pageCount > 1 && (
                            <View style={styles.pageRow}>
                                <Pressable accessibilityRole="button" accessibilityLabel="Previous files" disabled={browse.page === 0}
                                    onPress={() => setPage(browse.page - 1)}
                                    style={[styles.pageButton, { opacity: browse.page === 0 ? 0.4 : 1 }]}>
                                    <Ionicons name="chevron-back" size={18} color={theme.colors.text} />
                                </Pressable>
                                <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>{browse.page + 1} / {browse.pageCount}</Text>
                                <Pressable accessibilityRole="button" accessibilityLabel="Next files" disabled={browse.page >= browse.pageCount - 1}
                                    onPress={() => setPage(browse.page + 1)}
                                    style={[styles.pageButton, { opacity: browse.page >= browse.pageCount - 1 ? 0.4 : 1 }]}>
                                    <Ionicons name="chevron-forward" size={18} color={theme.colors.text} />
                                </Pressable>
                            </View>
                        )}
                    </>
                )}
            </ScrollView>
        </>
    );
}

const styles = StyleSheet.create((theme) => ({
    screen: { flex: 1, backgroundColor: theme.colors.groupped.background },
    content: { paddingBottom: 32 },
    scopeRow: {
        flexDirection: 'row', alignItems: 'center', gap: 6,
        paddingHorizontal: 14, paddingTop: 10, paddingBottom: 4,
    },
    scopeButton: { borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6, marginRight: 2 },
    summaryRow: { flexDirection: 'row', gap: 18, paddingHorizontal: 16, paddingVertical: 10 },
    summaryCell: { gap: 2 },
    pageRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 18, paddingVertical: 12 },
    pageButton: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceHigh },
}));
