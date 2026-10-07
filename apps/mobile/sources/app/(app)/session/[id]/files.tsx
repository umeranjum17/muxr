import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

import { CodeCore, PLUGIN_CODE_MAX_CHARS, PLUGIN_CODE_MAX_LINES } from '@/components/code/CodeCore';
import { MissingFileState } from '@/components/document/MissingFileState';
import { isMissingFileError } from '@/utils/errors';
import { filesList, filesRead, filesRepos } from '@/catalog/ops';
import { useHerdrTree, useSession } from '@/catalog/store';
import { herdrPaneForSession } from '@/herd';

type Repos = Awaited<ReturnType<typeof filesRepos>>;
type Listing = Awaited<ReturnType<typeof filesList>>;
type Preview = Awaited<ReturnType<typeof filesRead>>;

/**
 * The session's Files browser: repositories, tree, and bounded previews over
 * host-run git. Product surface (the browse half of the retired Files
 * add-on); the session cwd never travels from the client — the host injects
 * it, and an explicit root is either a repository open in some session or a
 * user-named absolute folder on the computer (listed from the filesystem).
 */
export default function FilesScreen() {
    // A tapped terminal path opens here with its repository, folder, and file.
    const { id: sessionId, paneId: routedPaneId, root: routedRoot, folder: routedFolder, file: routedFile } =
        useLocalSearchParams<{ id: string; paneId?: string; root?: string; folder?: string; file?: string }>();
    const { theme } = useUnistyles();
    const router = useRouter();
    const originalSession = useSession(sessionId);
    const { workspaces } = useHerdrTree();
    const originalPane = herdrPaneForSession(workspaces, sessionId);
    const discoveredPaneId = routedPaneId ?? originalSession?.metadata?.paneId ?? originalPane?.paneId;
    const [anchor, setAnchor] = React.useState({ route: sessionId, paneId: discoveredPaneId });
    React.useEffect(() => {
        setAnchor((previous) => {
            if (previous.route !== sessionId) return { route: sessionId, paneId: discoveredPaneId };
            if (discoveredPaneId === undefined || discoveredPaneId === previous.paneId) return previous;
            return { route: sessionId, paneId: discoveredPaneId };
        });
    }, [sessionId, discoveredPaneId]);
    // A provisional launch route can disappear; retain its pane as Herdr
    // publishes the settled route so this screen resumes without reopening.
    const pane = workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes))
        .find((candidate) => anchor.route === sessionId && candidate.paneId === anchor.paneId);
    const resolvedSessionId = pane?.sessionId ?? sessionId;
    const session = useSession(resolvedSessionId);
    const agent = pane ?? session?.metadata;
    const agentNotReady = agent?.agentKind !== undefined && agent.promptable === false;
    const waitingForAgent = session === null || agent?.agentStatus === 'starting' || agentNotReady;
    const [repos, setRepos] = React.useState<Repos | undefined>(undefined);
    const [root, setRoot] = React.useState<string | undefined>(routedRoot);
    const [path, setPath] = React.useState(routedFolder ?? '');
    const [listing, setListing] = React.useState<Listing | undefined>(undefined);
    const [preview, setPreview] = React.useState<Preview | undefined>(undefined);
    const [missingPath, setMissingPath] = React.useState<string | undefined>(undefined);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | undefined>(undefined);

    React.useEffect(() => {
        if (waitingForAgent) return;
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
    }, [waitingForAgent, resolvedSessionId]);

    React.useEffect(() => {
        if (waitingForAgent || root === undefined) { setListing(undefined); return; }
        let cancelled = false;
        setLoading(true);
        // A gone folder lands on the nearest ancestor that still lists.
        // Path segments first, then the root itself, never past '/'. An
        // unknown root counts as a repo root until the repos arrive.
        const isRepo = repos === undefined || repos.repos.some((repo) => repo.root === root);
        const attempts: Array<{ root: string; path: string }> = [{ root, path }];
        for (;;) {
            const last = attempts[attempts.length - 1]!;
            if (last.path !== '') {
                attempts.push({ root: last.root, path: last.path.split('/').slice(0, -1).join('/') });
                continue;
            }
            if (isRepo || last.root === '/') break;
            const slash = last.root.lastIndexOf('/');
            attempts.push({ root: slash <= 0 ? '/' : last.root.slice(0, slash), path: '' });
        }
        void (async () => {
            for (const attempt of attempts) {
                try {
                    const result = await filesList(resolvedSessionId, { root: attempt.root, ...(attempt.path === '' ? {} : { path: attempt.path }) });
                    if (cancelled) return;
                    // A walk-up landing is a new location: it drops a missing
                    // preview from the old one. An ordinary load leaves it
                    // alone, so a slow listing cannot clobber a fresh one.
                    if (attempt.root !== root) setRoot(attempt.root);
                    if (attempt.path !== path) setPath(attempt.path);
                    if (attempt.root !== root || attempt.path !== path) setMissingPath(undefined);
                    setListing(result);
                    setError(undefined);
                    return;
                } catch (cause: unknown) {
                    if (cancelled) return;
                    const message = cause instanceof Error ? cause.message : String(cause);
                    if (!isMissingFileError(message)) {
                        setError(message);
                        return;
                    }
                }
            }
            if (!cancelled) setError(attempts.length > 0 ? `Could not list ${root}` : 'Could not list files');
        })().finally(() => {
            if (!cancelled) setLoading(false);
        });
        return () => { cancelled = true; };
    }, [waitingForAgent, resolvedSessionId, repos, root, path]);

    const openPreview = React.useCallback((nodePath: string) => {
        if (waitingForAgent || root === undefined) return;
        setLoading(true);
        setMissingPath(undefined);
        // The tree speaks repo-relative paths; the preview endpoint resolves
        // them inside the root, symlinks included.
        filesRead(resolvedSessionId, { root, path: nodePath })
            .then((result) => {
                setPreview(result);
                setError(undefined);
            })
            .catch((cause: unknown) => {
                const message = cause instanceof Error ? cause.message : String(cause);
                // Gone is a destination, not a fault: the designed state
                // below, with a way forward, instead of a raw error line.
                // The tree path is kept as-is; the full path is composed
                // at render time against the current root.
                if (isMissingFileError(message)) {
                    setPreview(undefined);
                    setError(undefined);
                    setMissingPath(nodePath);
                    return;
                }
                setError(message);
            })
            .finally(() => setLoading(false));
    }, [waitingForAgent, resolvedSessionId, root]);

    const routedFileOpened = React.useRef(false);
    React.useEffect(() => {
        if (routedFile === undefined || routedFileOpened.current || waitingForAgent || root !== routedRoot) return;
        routedFileOpened.current = true;
        openPreview(routedFile);
    }, [routedFile, routedRoot, root, waitingForAgent, openPreview]);

    if (waitingForAgent) {
        return <>
            <Stack.Screen options={{ title: 'Files' }} />
            <View style={styles.waiting} accessibilityRole="progressbar" accessibilityLabel="Waiting for agent">
                <ActivityIndicator color={theme.colors.textSecondary} />
                <Text style={{ color: theme.colors.textSecondary, fontSize: 14 }}>Waiting for the agent to finish starting…</Text>
            </View>
        </>;
    }

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
                {loading && repos === undefined && listing === undefined && preview === undefined && missingPath === undefined
                    ? <ActivityIndicator color={theme.colors.textSecondary} />
                    : error !== undefined
                        ? <Text style={{ color: theme.colors.textDestructive, fontSize: 14 }}>{error}</Text>
                        : missingPath !== undefined
                            ? <MissingFileState
                                path={missingPath.startsWith('/') ? missingPath : `${root ?? ''}/${missingPath}`}
                                onOpenFolder={() => {
                                    const parent = missingPath.includes('/')
                                        ? missingPath.split('/').slice(0, -1).join('/')
                                        : '';
                                    setMissingPath(undefined);
                                    setPreview(undefined);
                                    setPath(parent);
                                }}
                                onBack={() => {
                                    setMissingPath(undefined);
                                    setPreview(undefined);
                                    if (routedFile !== undefined && routedFileOpened.current) router.back();
                                }}
                            />
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
                                    <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>{listing.scope === 'folder' ? `On this computer \u00b7 ${listing.count}` : listing.count}</Text>
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
    waiting: { flex: 1, padding: 16, gap: 12, alignItems: 'center', justifyContent: 'center' },
    content: { padding: 16, gap: 4 },
    row: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 4, paddingVertical: 8, borderRadius: 8 },
    back: { marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', padding: 8, borderRadius: 8 },
});
