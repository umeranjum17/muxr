import * as React from 'react';
import { ActivityIndicator, FlatList, Platform, Pressable, Text, View, type ViewToken } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
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
import { artifactKind } from '@/utils/artifactKind';
import type { ArtifactAction } from '@/utils/artifactPreview';
import { artifactTransferKey, cancelArtifactTransfer, useArtifactTransfers, type ArtifactTransfer } from '@/utils/artifactTransfer';
import { downloadArtifact, keptBytes, restoreReadyArtifact } from '@/utils/downloadArtifact';
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
        at: artifact.at,
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

    // The row shows progress, failure and retry; the promise has nothing to add.
    const download = React.useCallback((artifact: SessionArtifact) => {
        void downloadArtifact(sessionId, artifact).catch(() => undefined);
    }, [sessionId]);

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
                <TransferMeta key={sessionId} sessionId={sessionId} artifact={artifact} subtitle={subtitle} lines={snippets[artifact.id] === undefined ? 2 : 1} />
            </Pressable>
            <TransferControl key={sessionId} sessionId={sessionId} artifact={artifact} onDownload={download} />
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

/** Below this a download is one or two round trips: a spinner, not a progress readout. */
const PROGRESS_BYTES = 2 * 1024 * 1024;

function percentOf(received: number, total: number): number {
    return total === 0 ? 100 : Math.floor((received / total) * 100);
}

/** "71 of 169 MB": the received side takes the total's unit. */
function amountLabel(received: number, total: number): string {
    const [unit, scale] = total >= 1024 ** 3 ? ['GB', 1024 ** 3] : ['MB', 1024 ** 2];
    const digits = total / scale < 10 ? 1 : 0;
    return `${(received / scale).toFixed(digits)} of ${(total / scale).toFixed(digits)} ${unit}`;
}

function rateLabel(bytesPerSecond: number): string {
    if (bytesPerSecond < 1024 * 1024) return `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`;
    const mb = bytesPerSecond / 1024 / 1024;
    return `${mb.toFixed(mb < 10 ? 1 : 0)} MB/s`;
}

function remainingLabel(seconds: number): string {
    if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} s left`;
    if (seconds < 3600) return `${Math.ceil(seconds / 60)} min left`;
    return `${Math.ceil(seconds / 3600)} h left`;
}

function transferLine(transfer: ArtifactTransfer, artifact: SessionArtifact): string | undefined {
    if (transfer.status === 'ready') return `Ready to save · ${sizeLabel(transfer.total)}`;
    if (transfer.status === 'done') {
        return Platform.OS === 'web'
            ? `Saved to Downloads · ${sizeLabel(transfer.total)}`
            : `Downloaded · ${sizeLabel(transfer.total)} · ${kindLabel(artifact)}`;
    }
    const percent = percentOf(transfer.received, transfer.total);
    if (transfer.status === 'failed') return transfer.received > 0 ? `${transfer.message} at ${percent}%` : transfer.message;
    if (transfer.total <= PROGRESS_BYTES) return undefined;
    if (transfer.status === 'waiting') return `Paused at ${percent}% · Waiting for connection`;
    const parts = [`${percent}%`, amountLabel(transfer.received, transfer.total)];
    if (transfer.bytesPerSecond !== undefined && transfer.bytesPerSecond > 0) {
        parts.push(rateLabel(transfer.bytesPerSecond), remainingLabel((transfer.total - transfer.received) / transfer.bytesPerSecond));
    }
    return parts.join(' · ');
}

/**
 * Progress an earlier app run left on disk; resumes on the next tap. Read once
 * per row: after a download in this run the row follows that download, and a
 * cancelled one is still deleting its file when the row goes idle.
 */
function useKeptBytes(sessionId: string, artifact: SessionArtifact, transfer: ArtifactTransfer | undefined): number {
    const [kept, setKept] = React.useState(() => Platform.OS !== 'web' && artifact.size > PROGRESS_BYTES ? keptBytes(sessionId, artifact) : 0);
    const active = transfer !== undefined;
    React.useEffect(() => {
        if (active) setKept(0);
    }, [active]);
    return active ? 0 : kept;
}

function TransferMeta({ sessionId, artifact, subtitle, lines }: { sessionId: string; artifact: SessionArtifact; subtitle: string; lines: number }) {
    const transfer = useArtifactTransfers((all) => all[artifactTransferKey(sessionId, artifact)]);
    React.useEffect(() => {
        if (Platform.OS === 'web') void restoreReadyArtifact(sessionId, artifact);
    }, [sessionId, artifact.id, artifact.name, artifact.at, artifact.size]);
    const kept = useKeptBytes(sessionId, artifact, transfer);
    let line = transfer === undefined ? undefined : transferLine(transfer, artifact);
    let bar = transfer !== undefined && (transfer.status === 'downloading' || transfer.status === 'waiting') && transfer.total > PROGRESS_BYTES
        ? { received: transfer.received, paused: transfer.status === 'waiting' }
        : undefined;
    if (kept > 0) {
        line = `Paused at ${percentOf(kept, artifact.size)}% · Tap to resume`;
        bar = { received: kept, paused: true };
    }
    return <>
        <Text numberOfLines={lines} style={[styles.meta, transfer?.status === 'failed' && styles.metaFailed]}>{line ?? subtitle}</Text>
        {bar !== undefined && <View style={styles.track}>
            <View style={[styles.fill, bar.paused && styles.fillPaused, { width: `${percentOf(bar.received, artifact.size)}%` }]} />
        </View>}
    </>;
}

/** A ring that fills as bytes land, with a stop square to cancel. */
function ProgressRing({ progress, color, track }: { progress: number; color: string; track: string }) {
    const size = 30;
    const stroke = 2.5;
    const radius = (size - stroke) / 2;
    const circumference = 2 * Math.PI * radius;
    return <Svg width={size} height={size} style={styles.ring}>
        <Circle cx={size / 2} cy={size / 2} r={radius} stroke={track} strokeOpacity={0.3} strokeWidth={stroke} fill="none" />
        <Circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke={color}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={circumference * (1 - Math.min(1, Math.max(0, progress)))}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
    </Svg>;
}

function TransferControl({ sessionId, artifact, onDownload }: { sessionId: string; artifact: SessionArtifact; onDownload: (artifact: SessionArtifact) => void }) {
    const { theme } = useUnistyles();
    const transfer = useArtifactTransfers((all) => all[artifactTransferKey(sessionId, artifact)]);
    const kept = useKeptBytes(sessionId, artifact, transfer);
    const name = sharedArtifactDisplayName(artifact.name);
    const inProgress = transfer?.status === 'downloading' || transfer?.status === 'waiting';
    const percent = inProgress ? percentOf(transfer.received, transfer.total) : undefined;
    let label = kept > 0 ? `Resume downloading ${name}` : `Download ${name}`;
    let icon: React.ComponentProps<typeof Ionicons>['name'] = 'download-outline';
    if (inProgress) label = `Cancel download of ${name}`;
    else if (transfer?.status === 'failed') {
        label = `Retry downloading ${name}`;
        icon = 'refresh';
    } else if (transfer?.status === 'ready') {
        label = `Save ${name}`;
    } else if (transfer?.status === 'done' && Platform.OS === 'web') {
        label = `Save ${name} again`;
    } else if (transfer?.status === 'done') {
        label = artifactKind(artifact.name, artifact.mimeType) === 'apk' ? `Install ${name}` : `Open ${name}`;
        icon = 'open-outline';
    }
    let content = <Ionicons name={icon} size={19} color={theme.colors.textSecondary} />;
    if (inProgress && transfer.total <= PROGRESS_BYTES) content = <ActivityIndicator size="small" color={theme.colors.textSecondary} />;
    else if (inProgress) {
        content = <>
            <ProgressRing progress={transfer.received / transfer.total} color={transfer.status === 'waiting' ? theme.colors.textSecondary : theme.colors.text} track={theme.colors.textSecondary} />
            <View style={styles.stop} />
        </>;
    }
    return <Pressable
        onPress={() => inProgress ? cancelArtifactTransfer(artifactTransferKey(sessionId, artifact)) : onDownload(artifact)}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ busy: transfer?.status === 'downloading' }}
        {...(percent === undefined ? {} : { accessibilityValue: { min: 0, max: 100, now: percent } })}
        hitSlop={4}
        style={({ pressed }) => [styles.download, pressed && styles.pressed]}
    >
        {content}
    </Pressable>;
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
    meta: { color: theme.colors.textSecondary, fontSize: 11, lineHeight: 16, marginTop: 4, fontVariant: ['tabular-nums'] },
    metaFailed: { color: theme.colors.textDestructive },
    track: { height: 3, borderRadius: 1.5, marginTop: 7, overflow: 'hidden', backgroundColor: theme.colors.surfaceHighest },
    fill: { height: 3, borderRadius: 1.5, backgroundColor: theme.colors.text },
    fillPaused: { backgroundColor: theme.colors.textSecondary },
    download: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceHighest },
    ring: { position: 'absolute' },
    stop: { width: 9, height: 9, borderRadius: 2, backgroundColor: theme.colors.text },
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
