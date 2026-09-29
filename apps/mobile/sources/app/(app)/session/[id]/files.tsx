import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

import { CodeCore, PLUGIN_CODE_MAX_CHARS, PLUGIN_CODE_MAX_LINES } from '@/components/code/CodeCore';
import { filesList, filesRead, filesRepos } from '@/catalog/ops';

type Repos = Awaited<ReturnType<typeof filesRepos>>;
type Listing = Awaited<ReturnType<typeof filesList>>;
type Preview = Awaited<ReturnType<typeof filesRead>>;

/**
 * The session's Files browser: repositories, tree, and bounded previews over
 * host-run git. Product surface (the browse half of the retired Files
 * add-on); the session cwd never travels from the client — the host injects
 * it, and an explicit root must be a repository open in some session.
 */
export default function FilesScreen() {
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();
    const { theme } = useUnistyles();
    const [repos, setRepos] = React.useState<Repos | undefined>(undefined);
    const [root, setRoot] = React.useState<string | undefined>(undefined);
    const [path, setPath] = React.useState('');
    const [listing, setListing] = React.useState<Listing | undefined>(undefined);
    const [preview, setPreview] = React.useState<Preview | undefined>(undefined);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | undefined>(undefined);

    React.useEffect(() => {
        let cancelled = false;
        setLoading(true);
        filesRepos()
            .then((result) => {
                if (cancelled) return;
                setRepos(result);
                setError(undefined);
            })
            .catch((cause: unknown) => {
                if (cancelled) return;
                setError(cause instanceof Error ? cause.message : String(cause));
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => { cancelled = true; };
    }, []);

    React.useEffect(() => {
        if (root === undefined) { setListing(undefined); return; }
        let cancelled = false;
        setLoading(true);
        filesList(sessionId, { root, ...(path === '' ? {} : { path }) })
            .then((result) => {
                if (cancelled) return;
                setListing(result);
                setError(undefined);
            })
            .catch((cause: unknown) => {
                if (cancelled) return;
                setError(cause instanceof Error ? cause.message : String(cause));
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => { cancelled = true; };
    }, [sessionId, root, path]);

    const openPreview = React.useCallback((nodePath: string) => {
        if (root === undefined) return;
        setLoading(true);
        // The tree speaks repo-relative paths; the preview endpoint resolves
        // them inside the root, symlinks included.
        filesRead(sessionId, { root, path: nodePath })
            .then((result) => {
                setPreview(result);
                setError(undefined);
            })
            .catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : String(cause));
            })
            .finally(() => setLoading(false));
    }, [sessionId, root]);

    const title = preview !== undefined
        ? preview.name
        : listing !== undefined
            ? listing.title
            : repos !== undefined ? repos.title : 'Files';
    const crumb = path === '' ? undefined : path.split('/').pop();

    return (
        <>
            <Stack.Screen options={{ title }} />
            <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
                {loading && repos === undefined && listing === undefined && preview === undefined
                    ? <ActivityIndicator color={theme.colors.textSecondary} />
                    : error !== undefined
                        ? <Text style={{ color: theme.colors.textDestructive, fontSize: 14 }}>{error}</Text>
                        : preview !== undefined
                            ? <>
                                <CodeCore code={preview.body} header fileName={preview.path} maxLines={PLUGIN_CODE_MAX_LINES} maxChars={PLUGIN_CODE_MAX_CHARS} />
                                {preview.note !== '' && <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 8 }}>{preview.note}</Text>}
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityLabel="Back to files"
                                    onPress={() => setPreview(undefined)}
                                    style={({ pressed }) => [styles.back, pressed && { backgroundColor: theme.colors.surfacePressed }]}
                                >
                                    <Ionicons name="chevron-back" size={16} color={theme.colors.textSecondary} />
                                    <Text style={{ color: theme.colors.textSecondary, fontSize: 14 }}>{crumb ?? listing?.title ?? 'Files'}</Text>
                                </Pressable>
                            </>
                            : listing !== undefined
                                ? <>
                                    <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>{listing.count}</Text>
                                    {path !== '' && (
                                        <Pressable
                                            accessibilityRole="button"
                                            accessibilityLabel="Up one folder"
                                            onPress={() => {
                                                const parent = path.split('/').slice(0, -1).join('/');
                                                setPath(parent);
                                            }}
                                            style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.colors.surfacePressed }]}
                                        >
                                            <Ionicons name="folder-outline" size={18} color={theme.colors.textSecondary} />
                                            <Text style={{ color: theme.colors.text, fontSize: 15 }}>..</Text>
                                        </Pressable>
                                    )}
                                    {listing.tree.map((node) => (
                                        <Pressable
                                            key={node.path}
                                            accessibilityRole="button"
                                            accessibilityLabel={`${node.kind} ${node.name}`}
                                            onPress={() => {
                                                if (node.kind === 'folder') setPath(node.path);
                                                else openPreview(node.path);
                                            }}
                                            style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.colors.surfacePressed }]}
                                        >
                                            <Ionicons
                                                name={node.kind === 'folder' ? 'folder-outline' : 'document-text-outline'}
                                                size={18}
                                                color={theme.colors.textSecondary}
                                            />
                                            <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }} numberOfLines={1}>{node.name}</Text>
                                            <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                                        </Pressable>
                                    ))}
                                    {listing.tree.length === 0 && <Text style={{ color: theme.colors.textSecondary, fontSize: 14 }}>No files</Text>}
                                    {listing.treeNote !== '' && <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 8 }}>{listing.treeNote}</Text>}
                                </>
                                : <>
                                    {repos?.repos.map((repo) => (
                                        <Pressable
                                            key={repo.root}
                                            accessibilityRole="button"
                                            accessibilityLabel={`Repository ${repo.name}`}
                                            onPress={() => { setRoot(repo.root); setPath(''); }}
                                            style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.colors.surfacePressed }]}
                                        >
                                            <Ionicons name="folder-outline" size={18} color={theme.colors.textSecondary} />
                                            <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }} numberOfLines={1}>{repo.name}</Text>
                                            <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                                        </Pressable>
                                    ))}
                                    {(repos?.repos.length ?? 0) === 0 && <Text style={{ color: theme.colors.textSecondary, fontSize: 14 }}>No git repositories open</Text>}
                                </>}
            </ScrollView>
        </>
    );
}

const styles = StyleSheet.create({
    screen: { flex: 1 },
    content: { padding: 16, gap: 4 },
    row: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 4, paddingVertical: 8, borderRadius: 8 },
    back: { marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', padding: 8, borderRadius: 8 },
});
