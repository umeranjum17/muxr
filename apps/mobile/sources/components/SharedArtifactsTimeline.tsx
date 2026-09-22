import * as React from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View, type ViewToken } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { RequestResult, SessionArtifact } from '@muxr/contract';

import { sync, registerArtifactUpdateHandler } from '@/catalog/sync';
import { useHerdrTree } from '@/catalog/store';
import { buildSharedArtifactTimeline, planArtifactHeal, sharedArtifactDisplayName, type SharedArtifactTimelineRow } from '@/catalog/infrastructure/artifactSupport';
import { AgentGlyph } from '@/components/AgentGlyph';
import { ArtifactGallery, ArtifactThumbnail, type GalleryImage } from '@/components/ArtifactGallery';
import { RichArtifactPreview } from '@/components/artifact/RichArtifactPreview';
import { agentLabels, agentNameLine, herdrPaneForSession, isShellLabels } from '@/herd';
import { decodeBase64 } from '@/encryption/base64';
import { Modal } from '@/modal';
import { artifactKind } from '@/utils/artifactKind';
import type { ArtifactAction } from '@/utils/artifactPreview';
import { downloadArtifact } from '@/utils/downloadArtifact';
import { richPreviewKind } from '@/utils/richArtifactPreview';

type ArtifactList = RequestResult<'artifact.list'>;
type TimelineRow = SharedArtifactTimelineRow<SessionArtifact>;

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const EMPTY_ARTIFACTS: SessionArtifact[] = [];

function artifactAction(artifact: SessionArtifact): ArtifactAction {
    return {
        type: 'attachment',
        id: artifact.id,
        name: artifact.name,
        mimeType: artifact.mimeType,
        size: artifact.size,
    };
}

function sizeLabel(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function kindLabel(artifact: SessionArtifact): string {
    const kind = artifactKind(artifact.name, artifact.mimeType);
    if (kind === 'apk') return 'Android app';
    return kind[0]!.toUpperCase() + kind.slice(1);
}

function iconFor(artifact: SessionArtifact): React.ComponentProps<typeof Ionicons>['name'] {
    const kind = artifactKind(artifact.name, artifact.mimeType);
    if (kind === 'video') return 'videocam-outline';
    if (kind === 'document') return 'document-text-outline';
    if (kind === 'apk') return 'logo-android';
    if (kind === 'image') return 'image-outline';
    return 'document-attach-outline';
}

export function SharedArtifactsTimeline({ sessionId }: { sessionId: string }) {
    const { theme } = useUnistyles();
    const { workspaces } = useHerdrTree();
    const pane = herdrPaneForSession(workspaces, sessionId);
    const labels = agentLabels(pane);
    const glyph = pane?.agentKind ?? (isShellLabels(labels) ? 'shell' : labels.agentName);
    const [listing, setListing] = React.useState<ArtifactList>();
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState<string>();
    const [galleryIndex, setGalleryIndex] = React.useState<number>();
    const [documentPreview, setDocumentPreview] = React.useState<ArtifactAction>();
    const [downloadingId, setDownloadingId] = React.useState<string>();
    const [visibleImageKeys, setVisibleImageKeys] = React.useState<string[]>([]);
    const [visibleTextIds, setVisibleTextIds] = React.useState<string[]>([]);
    const [snippets, setSnippets] = React.useState<Record<string, string>>({});
    const attemptedSnippets = React.useRef(new Set<string>());
    const snippetSession = React.useRef(sessionId);
    const requestGeneration = React.useRef(0);
    const liveRevision = React.useRef(0);

    const load = React.useCallback(() => {
        const generation = ++requestGeneration.current;
        const expectedLiveRevision = liveRevision.current;
        setLoading(true);
        void sync.artifactList(sessionId)
            .then((next) => {
                if (generation !== requestGeneration.current || expectedLiveRevision !== liveRevision.current) return;
                setListing(next);
                setError(undefined);
            })
            .catch((cause: unknown) => {
                if (generation !== requestGeneration.current) return;
                setError(cause instanceof Error ? cause.message : 'Shared Artifacts are unavailable.');
            })
            .finally(() => {
                if (generation === requestGeneration.current) setLoading(false);
            });
    }, [sessionId]);

    React.useEffect(() => registerArtifactUpdateHandler((updatedSessionId, event) => {
        if (updatedSessionId !== sessionId) return;
        liveRevision.current += 1;
        setListing({ artifacts: event.artifacts, total: event.total, truncated: event.truncated });
        setError(undefined);
    }), [sessionId]);

    useFocusEffect(React.useCallback(() => {
        load();
        return () => { requestGeneration.current += 1; };
    }, [load]));

    const artifacts = listing?.artifacts ?? EMPTY_ARTIFACTS;
    React.useEffect(() => {
        attemptedSnippets.current.clear();
        snippetSession.current = sessionId;
        setSnippets({});
        setVisibleTextIds([]);
    }, [sessionId]);
    // A snippet is one line under a row's name, and it costs a whole-file
    // fetch plus a decode to produce. Rows nobody has scrolled to do not get
    // one: on a pane with a long history this was eight full payloads pulled
    // and decoded on mount for rows that were never on screen.
    const visibleTextSet = React.useMemo(() => new Set(visibleTextIds), [visibleTextIds]);
    React.useEffect(() => {
        const unique = new Map<string, SessionArtifact>();
        for (const artifact of artifacts) {
            if (artifact.mimeType.startsWith('text/') && visibleTextSet.has(artifact.id) && !attemptedSnippets.current.has(artifact.id)) unique.set(artifact.id, artifact);
        }
        const plan = planArtifactHeal([...unique.values()]);
        for (const artifact of plan.candidates) attemptedSnippets.current.add(artifact.id);
        void Promise.all(plan.candidates.map(async (artifact) => {
            try {
                const healed = await sync.artifactFetch(sessionId, artifact.id);
                if (healed === null) return;
                const text = new TextDecoder().decode(decodeBase64(healed.data));
                const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim().replace(/\s+/g, ' ').slice(0, 160);
                if (firstLine !== undefined && firstLine.length > 0 && snippetSession.current === sessionId) {
                    setSnippets((current) => ({ ...current, [artifact.id]: firstLine }));
                }
            } catch {
                attemptedSnippets.current.delete(artifact.id);
            }
        }));
    }, [artifacts, sessionId, visibleTextSet]);
    const rows = React.useMemo(() => buildSharedArtifactTimeline(artifacts), [artifacts]);
    const galleryImages = React.useMemo<GalleryImage[]>(() => artifacts.flatMap((artifact) => (
        artifact.mimeType.startsWith('image/') && richPreviewKind(artifact.name) !== 'svg'
            ? [{
                id: `${artifact.id}:${artifact.name}:${artifact.at}`,
                title: sharedArtifactDisplayName(artifact.name),
                subtitle: `${sizeLabel(artifact.size)} · ${TIME_FORMAT.format(new Date(artifact.at))}`,
                action: artifactAction(artifact),
            }]
            : []
    )), [artifacts]);
    const galleryIndexByKey = React.useMemo(() => new Map(galleryImages.map((image, index) => [image.id, index])), [galleryImages]);
    const visibleImageSet = React.useMemo(() => new Set(visibleImageKeys), [visibleImageKeys]);
    const viewabilityConfig = React.useRef({ itemVisiblePercentThreshold: 10 }).current;
    const onViewableItemsChanged = React.useRef(({ viewableItems }: { viewableItems: ViewToken<TimelineRow>[] }) => {
        const next = viewableItems.flatMap(({ item }) => item?.type === 'artifact' && item.artifact.mimeType.startsWith('image/')
            ? [item.key]
            : []);
        setVisibleImageKeys((current) => current.length === next.length && current.every((key, index) => key === next[index]) ? current : next);
        const text = viewableItems.flatMap(({ item }) => item?.type === 'artifact' && item.artifact.mimeType.startsWith('text/')
            ? [item.artifact.id]
            : []);
        setVisibleTextIds((current) => current.length === text.length && current.every((id, index) => id === text[index]) ? current : text);
    }).current;

    const download = React.useCallback((artifact: SessionArtifact) => {
        if (downloadingId !== undefined) return;
        setDownloadingId(artifact.id);
        void downloadArtifact(sessionId, artifact)
            .catch((cause: unknown) => Modal.alert('Download failed', cause instanceof Error ? cause.message : String(cause)))
            .finally(() => setDownloadingId(undefined));
    }, [downloadingId, sessionId]);

    const open = React.useCallback((artifact: SessionArtifact) => {
        const key = `${artifact.id}:${artifact.name}:${artifact.at}`;
        const imageIndex = galleryIndexByKey.get(key);
        if (imageIndex !== undefined) {
            setGalleryIndex(imageIndex);
            return;
        }
        if (richPreviewKind(artifact.name) !== null) {
            setDocumentPreview(artifactAction(artifact));
            return;
        }
        download(artifact);
    }, [download, galleryIndexByKey]);

    const contextTitle = agentNameLine(labels) || 'Session';
    const contextSubtitle = listing === undefined ? 'Shared history' : listing.total === 1 ? '1 shared artifact' : `${listing.total} shared artifacts`;

    const renderArtifact = (row: Extract<TimelineRow, { type: 'artifact' }>) => {
        const artifact = row.artifact;
        const imageIndex = galleryIndexByKey.get(`${artifact.id}:${artifact.name}:${artifact.at}`);
        const subtitle = `${TIME_FORMAT.format(new Date(artifact.at))} · ${sizeLabel(artifact.size)} · ${kindLabel(artifact)}`;
        return <View style={styles.card}>
            {imageIndex === undefined
                ? <View style={styles.iconTile}><Ionicons name={iconFor(artifact)} size={24} color={theme.colors.textSecondary} /></View>
                : <ArtifactThumbnail
                    sessionId={sessionId}
                    image={galleryImages[imageIndex]!}
                    enabled={visibleImageSet.has(row.key)}
                    showCaption={false}
                    style={styles.thumbnail}
                    onPress={() => setGalleryIndex(imageIndex)}
                />}
            <Pressable
                onPress={() => open(artifact)}
                accessibilityRole="button"
                accessibilityLabel={`Open ${sharedArtifactDisplayName(artifact.name)}, ${subtitle}`}
                style={({ pressed }) => [styles.details, pressed && styles.pressed]}
            >
                <Text numberOfLines={snippets[artifact.id] === undefined ? 2 : 1} style={styles.title}>{sharedArtifactDisplayName(artifact.name)}</Text>
                {snippets[artifact.id] !== undefined && <Text numberOfLines={1} style={styles.snippet}>{snippets[artifact.id]}</Text>}
                <Text numberOfLines={snippets[artifact.id] === undefined ? 2 : 1} style={styles.meta}>{subtitle}</Text>
            </Pressable>
            <Pressable
                onPress={() => download(artifact)}
                disabled={downloadingId !== undefined}
                accessibilityRole="button"
                accessibilityLabel={`Download ${sharedArtifactDisplayName(artifact.name)}`}
                accessibilityState={{ busy: downloadingId === artifact.id, disabled: downloadingId !== undefined }}
                hitSlop={4}
                style={({ pressed }) => [styles.download, pressed && styles.pressed, downloadingId !== undefined && downloadingId !== artifact.id && styles.disabled]}
            >
                {downloadingId === artifact.id
                    ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    : <Ionicons name="download-outline" size={19} color={theme.colors.textSecondary} />}
            </Pressable>
        </View>;
    };

    return <View style={styles.screen}>
        <View style={styles.context}>
            <AgentGlyph name={glyph} size={24} />
            <View style={styles.contextText}>
                <Text numberOfLines={1} style={styles.contextTitle}>{contextTitle}</Text>
                <Text numberOfLines={1} style={styles.contextSubtitle}>{contextSubtitle}</Text>
            </View>
            <Pressable onPress={load} disabled={loading} accessibilityRole="button" accessibilityLabel="Refresh Shared Artifacts" accessibilityState={{ busy: loading }} hitSlop={6} style={({ pressed }) => [styles.refresh, pressed && styles.pressed]}>
                {loading && listing !== undefined
                    ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    : <Ionicons name="refresh" size={20} color={theme.colors.textSecondary} />}
            </Pressable>
        </View>

        {listing === undefined && loading ? <View style={styles.skeletons} accessibilityLabel="Loading Shared Artifacts">
            {[0, 1, 2].map((index) => <View key={index} style={styles.skeletonCard}>
                <View style={styles.skeletonPreview} />
                <View style={styles.skeletonText}><View style={styles.skeletonTitle} /><View style={styles.skeletonMeta} /></View>
            </View>)}
        </View> : listing === undefined && error !== undefined ? <View style={styles.state}>
            <Ionicons name="cloud-offline-outline" size={34} color={theme.colors.textSecondary} />
            <Text style={styles.stateTitle}>Shared Artifacts unavailable</Text>
            <Text style={styles.stateBody}>{error}</Text>
            <Pressable onPress={load} accessibilityRole="button" accessibilityLabel="Retry loading Shared Artifacts" style={({ pressed }) => [styles.retry, pressed && styles.pressed]}><Text style={styles.retryText}>Try again</Text></Pressable>
        </View> : artifacts.length === 0 ? <View style={styles.state}>
            <View style={styles.emptyIcon}><Ionicons name="albums-outline" size={28} color={theme.colors.textSecondary} /></View>
            <Text style={styles.stateTitle}>No shared artifacts yet</Text>
            <Text style={styles.stateBody}>Agents can add images, documents, recordings, and other files with <Text style={styles.command}>muxr share</Text>.</Text>
        </View> : <FlatList
            data={rows}
            keyExtractor={(row) => row.key}
            renderItem={({ item }) => item.type === 'day'
                ? <Text style={styles.day}>{item.label}</Text>
                : renderArtifact(item)}
            contentContainerStyle={styles.content}
            refreshing={loading}
            onRefresh={load}
            viewabilityConfig={viewabilityConfig}
            onViewableItemsChanged={onViewableItemsChanged}
            initialNumToRender={8}
            maxToRenderPerBatch={6}
            windowSize={5}
            ListHeaderComponent={error === undefined ? null : <Pressable onPress={load} accessibilityRole="button" accessibilityLabel="Retry refreshing Shared Artifacts" style={styles.stale}>
                <Ionicons name="warning-outline" size={16} color={theme.colors.textSecondary} />
                <Text style={styles.staleText}>Showing the last update. Tap to retry.</Text>
            </Pressable>}
            ListFooterComponent={listing?.truncated ? <Text style={styles.footer}>Showing newest {artifacts.length} of {listing.total}</Text> : <View style={styles.footerSpace} />}
        />}

        {galleryIndex !== undefined && <ArtifactGallery sessionId={sessionId} images={galleryImages} initialIndex={galleryIndex} onClose={() => setGalleryIndex(undefined)} />}
        {documentPreview !== undefined && <RichArtifactPreview key={`${sessionId}:${documentPreview.id}`} sessionId={sessionId} artifact={documentPreview} onClose={() => setDocumentPreview(undefined)} />}
    </View>;
}

const styles = StyleSheet.create((theme) => ({
    screen: { flex: 1, backgroundColor: theme.colors.groupped.background },
    context: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: theme.colors.surface },
    contextText: { flex: 1, minWidth: 0 },
    contextTitle: { color: theme.colors.text, fontSize: 15, fontWeight: '600' },
    contextSubtitle: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 },
    refresh: { width: 44, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    content: { width: '100%', maxWidth: 680, alignSelf: 'center', paddingHorizontal: 12, paddingTop: 4, paddingBottom: 24 },
    day: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: '600', letterSpacing: 0.2, paddingTop: 16, paddingBottom: 7, paddingHorizontal: 3 },
    card: { minHeight: 96, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 8, marginBottom: 8, borderRadius: 15, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh, overflow: 'hidden' },
    thumbnail: { width: 80, height: 80, aspectRatio: undefined, borderRadius: 11 },
    iconTile: { width: 80, height: 80, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.accentSubtle },
    details: { flex: 1, minWidth: 0, minHeight: 64, justifyContent: 'center', borderRadius: 8 },
    title: { color: theme.colors.text, fontSize: 15, lineHeight: 19, fontWeight: '600' },
    snippet: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 16, marginTop: 3 },
    meta: { color: theme.colors.textSecondary, fontSize: 11, lineHeight: 16, marginTop: 4 },
    download: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceHighest },
    disabled: { opacity: 0.45 },
    pressed: { opacity: 0.72, transform: [{ scale: 0.97 }] },
    skeletons: { width: '100%', maxWidth: 680, alignSelf: 'center', paddingHorizontal: 12, paddingTop: 20, gap: 8 },
    skeletonCard: { height: 96, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 8, borderRadius: 15, backgroundColor: theme.colors.surfaceHigh },
    skeletonPreview: { width: 80, height: 80, borderRadius: 11, backgroundColor: theme.colors.surfaceHighest },
    skeletonText: { flex: 1, gap: 9 },
    skeletonTitle: { width: '68%', height: 14, borderRadius: 7, backgroundColor: theme.colors.surfaceHighest },
    skeletonMeta: { width: '88%', height: 10, borderRadius: 5, backgroundColor: theme.colors.surfaceHighest },
    state: { flex: 1, minHeight: 260, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, paddingBottom: 40 },
    emptyIcon: { width: 58, height: 58, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginBottom: 14, backgroundColor: theme.colors.surfaceHigh, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    stateTitle: { color: theme.colors.text, fontSize: 17, fontWeight: '600', textAlign: 'center' },
    stateBody: { maxWidth: 360, color: theme.colors.textSecondary, fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 7 },
    command: { color: theme.colors.text, fontWeight: '600' },
    retry: { minHeight: 44, justifyContent: 'center', marginTop: 14, paddingHorizontal: 16, borderRadius: 12, backgroundColor: theme.colors.surfaceHigh },
    retryText: { color: theme.colors.text, fontSize: 14, fontWeight: '600' },
    stale: { minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, paddingHorizontal: 12, borderRadius: 12, backgroundColor: theme.colors.surfaceHigh },
    staleText: { flex: 1, color: theme.colors.textSecondary, fontSize: 12 },
    footer: { color: theme.colors.textSecondary, fontSize: 12, textAlign: 'center', paddingTop: 12, paddingBottom: 8 },
    footerSpace: { height: 8 },
}));
