import * as React from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View, type ViewToken } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { RequestResult, SessionAttachment } from '@muxr/contract';

import { sync, registerAttachmentUpdateHandler } from '@/catalog/sync';
import { useHerdrTree } from '@/catalog/store';
import { buildSharedArtifactTimeline, planAttachmentHeal, sharedArtifactDisplayName, type SharedArtifactTimelineRow } from '@/catalog/infrastructure/attachmentSupport';
import { AgentGlyph } from '@/components/AgentGlyph';
import { AttachmentGallery, AttachmentThumbnail, type GalleryImage } from '@/components/AttachmentGallery';
import { RichAttachmentPreview } from '@/components/attachment/RichAttachmentPreview';
import { agentLabels, agentNameLine, herdrPaneForSession, isShellLabels } from '@/herd';
import { decodeBase64 } from '@/encryption/base64';
import { Modal } from '@/modal';
import { attachmentKind } from '@/utils/attachmentKind';
import type { AttachmentAction } from '@/utils/attachmentPreview';
import { downloadAttachment } from '@/utils/downloadAttachment';
import { richPreviewKind } from '@/utils/richAttachmentPreview';

type ArtifactList = RequestResult<'attachment.list'>;
type TimelineRow = SharedArtifactTimelineRow<SessionAttachment>;

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const EMPTY_ATTACHMENTS: SessionAttachment[] = [];

function attachmentAction(attachment: SessionAttachment): AttachmentAction {
    return {
        type: 'attachment',
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
    };
}

function sizeLabel(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function kindLabel(attachment: SessionAttachment): string {
    const kind = attachmentKind(attachment.name, attachment.mimeType);
    if (kind === 'apk') return 'Android app';
    return kind[0]!.toUpperCase() + kind.slice(1);
}

function iconFor(attachment: SessionAttachment): React.ComponentProps<typeof Ionicons>['name'] {
    const kind = attachmentKind(attachment.name, attachment.mimeType);
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
    const [documentPreview, setDocumentPreview] = React.useState<AttachmentAction>();
    const [downloadingId, setDownloadingId] = React.useState<string>();
    const [visibleImageKeys, setVisibleImageKeys] = React.useState<string[]>([]);
    const [snippets, setSnippets] = React.useState<Record<string, string>>({});
    const attemptedSnippets = React.useRef(new Set<string>());
    const requestGeneration = React.useRef(0);
    const liveRevision = React.useRef(0);

    const load = React.useCallback(() => {
        const generation = ++requestGeneration.current;
        const expectedLiveRevision = liveRevision.current;
        setLoading(true);
        void sync.request('attachment.list', { sessionId })
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

    React.useEffect(() => registerAttachmentUpdateHandler((updatedSessionId, event) => {
        if (updatedSessionId !== sessionId) return;
        liveRevision.current += 1;
        setListing({ attachments: event.attachments, total: event.total, truncated: event.truncated });
        setError(undefined);
    }), [sessionId]);

    useFocusEffect(React.useCallback(() => {
        load();
        return () => { requestGeneration.current += 1; };
    }, [load]));

    const attachments = listing?.attachments ?? EMPTY_ATTACHMENTS;
    React.useEffect(() => {
        attemptedSnippets.current.clear();
        setSnippets({});
    }, [sessionId]);
    React.useEffect(() => {
        let cancelled = false;
        const unique = new Map<string, SessionAttachment>();
        for (const attachment of attachments) {
            if (attachment.mimeType.startsWith('text/') && !attemptedSnippets.current.has(attachment.id)) unique.set(attachment.id, attachment);
        }
        const plan = planAttachmentHeal([...unique.values()]);
        for (const attachment of plan.candidates) attemptedSnippets.current.add(attachment.id);
        void Promise.all(plan.candidates.map(async (attachment) => {
            try {
                const healed = await sync.request('attachment.fetch', { sessionId, attachmentId: attachment.id });
                if (healed === null) return;
                const text = new TextDecoder().decode(decodeBase64(healed.data));
                const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim().replace(/\s+/g, ' ').slice(0, 160);
                if (firstLine !== undefined && firstLine.length > 0 && !cancelled) {
                    setSnippets((current) => ({ ...current, [attachment.id]: firstLine }));
                }
            } catch {
                attemptedSnippets.current.delete(attachment.id);
            }
        }));
        return () => { cancelled = true; };
    }, [attachments, sessionId]);
    const rows = React.useMemo(() => buildSharedArtifactTimeline(attachments), [attachments]);
    const galleryImages = React.useMemo<GalleryImage[]>(() => attachments.flatMap((attachment) => (
        attachment.mimeType.startsWith('image/') && richPreviewKind(attachment.name) !== 'svg'
            ? [{
                id: `${attachment.id}:${attachment.name}:${attachment.at}`,
                title: sharedArtifactDisplayName(attachment.name),
                subtitle: `${sizeLabel(attachment.size)} · ${TIME_FORMAT.format(new Date(attachment.at))}`,
                action: attachmentAction(attachment),
            }]
            : []
    )), [attachments]);
    const galleryIndexByKey = React.useMemo(() => new Map(galleryImages.map((image, index) => [image.id, index])), [galleryImages]);
    const visibleImageSet = React.useMemo(() => new Set(visibleImageKeys), [visibleImageKeys]);
    const viewabilityConfig = React.useRef({ itemVisiblePercentThreshold: 10 }).current;
    const onViewableItemsChanged = React.useRef(({ viewableItems }: { viewableItems: ViewToken<TimelineRow>[] }) => {
        const next = viewableItems.flatMap(({ item }) => item?.type === 'artifact' && item.artifact.mimeType.startsWith('image/')
            ? [item.key]
            : []);
        setVisibleImageKeys((current) => current.length === next.length && current.every((key, index) => key === next[index]) ? current : next);
    }).current;

    const download = React.useCallback((attachment: SessionAttachment) => {
        if (downloadingId !== undefined) return;
        setDownloadingId(attachment.id);
        void downloadAttachment(sessionId, attachment)
            .catch((cause: unknown) => Modal.alert('Download failed', cause instanceof Error ? cause.message : String(cause)))
            .finally(() => setDownloadingId(undefined));
    }, [downloadingId, sessionId]);

    const open = React.useCallback((attachment: SessionAttachment) => {
        const key = `${attachment.id}:${attachment.name}:${attachment.at}`;
        const imageIndex = galleryIndexByKey.get(key);
        if (imageIndex !== undefined) {
            setGalleryIndex(imageIndex);
            return;
        }
        if (richPreviewKind(attachment.name) !== null) {
            setDocumentPreview(attachmentAction(attachment));
            return;
        }
        download(attachment);
    }, [download, galleryIndexByKey]);

    const contextTitle = agentNameLine(labels) || 'Session';
    const contextSubtitle = listing === undefined ? 'Shared history' : listing.total === 1 ? '1 shared artifact' : `${listing.total} shared artifacts`;

    const renderArtifact = (row: Extract<TimelineRow, { type: 'artifact' }>) => {
        const attachment = row.artifact;
        const imageIndex = galleryIndexByKey.get(`${attachment.id}:${attachment.name}:${attachment.at}`);
        const subtitle = `${TIME_FORMAT.format(new Date(attachment.at))} · ${sizeLabel(attachment.size)} · ${kindLabel(attachment)}`;
        return <View style={styles.card}>
            {imageIndex === undefined
                ? <View style={styles.iconTile}><Ionicons name={iconFor(attachment)} size={24} color={theme.colors.textSecondary} /></View>
                : <AttachmentThumbnail
                    sessionId={sessionId}
                    image={galleryImages[imageIndex]!}
                    enabled={visibleImageSet.has(row.key)}
                    showCaption={false}
                    style={styles.thumbnail}
                    onPress={() => setGalleryIndex(imageIndex)}
                />}
            <Pressable
                onPress={() => open(attachment)}
                accessibilityRole="button"
                accessibilityLabel={`Open ${sharedArtifactDisplayName(attachment.name)}, ${subtitle}`}
                style={({ pressed }) => [styles.details, pressed && styles.pressed]}
            >
                <Text numberOfLines={snippets[attachment.id] === undefined ? 2 : 1} style={styles.title}>{sharedArtifactDisplayName(attachment.name)}</Text>
                {snippets[attachment.id] !== undefined && <Text numberOfLines={1} style={styles.snippet}>{snippets[attachment.id]}</Text>}
                <Text numberOfLines={snippets[attachment.id] === undefined ? 2 : 1} style={styles.meta}>{subtitle}</Text>
            </Pressable>
            <Pressable
                onPress={() => download(attachment)}
                disabled={downloadingId !== undefined}
                accessibilityRole="button"
                accessibilityLabel={`Download ${sharedArtifactDisplayName(attachment.name)}`}
                accessibilityState={{ busy: downloadingId === attachment.id, disabled: downloadingId !== undefined }}
                hitSlop={4}
                style={({ pressed }) => [styles.download, pressed && styles.pressed, downloadingId !== undefined && downloadingId !== attachment.id && styles.disabled]}
            >
                {downloadingId === attachment.id
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
        </View> : attachments.length === 0 ? <View style={styles.state}>
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
            ListFooterComponent={listing?.truncated ? <Text style={styles.footer}>Showing newest {attachments.length} of {listing.total}</Text> : <View style={styles.footerSpace} />}
        />}

        {galleryIndex !== undefined && <AttachmentGallery sessionId={sessionId} images={galleryImages} initialIndex={galleryIndex} onClose={() => setGalleryIndex(undefined)} />}
        {documentPreview !== undefined && <RichAttachmentPreview key={`${sessionId}:${documentPreview.id}`} sessionId={sessionId} attachment={documentPreview} onClose={() => setDocumentPreview(undefined)} />}
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
