import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

import { ArtifactGallery, ArtifactThumbnail, type GalleryImage } from '@/components/ArtifactGallery';
import { RichArtifactPreview } from '@/components/artifact/RichArtifactPreview';
import { downloadArtifact } from '@/utils/downloadArtifact';
import { richPreviewKind } from '@/utils/richArtifactPreview';
import type { ArtifactAction } from '@/utils/artifactPreview';
import { promptAttachmentsList } from '@/catalog/ops';
import type { PromptAttachmentItem } from '@trymuxr/contract';

type Listing = Awaited<ReturnType<typeof promptAttachmentsList>>;

const isImage = (item: PromptAttachmentItem): boolean =>
    item.action.mimeType.startsWith('image/') && richPreviewKind(item.action.name) !== 'svg';

/**
 * The session pane's prompt-attachments listing: the dump directory's files
 * for attaching to a prompt. Product surface (the retired Attachments
 * add-on's pill, same rows, thumbnails, gallery, and tap behavior); the pane
 * resolves from the session record, so a client can never choose a dump
 * directory. Bytes never ride this listing — opening an item resolves through
 * the artifact transports by content id.
 */
export default function AttachmentsScreen() {
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    const [listing, setListing] = React.useState<Listing | undefined>(undefined);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | undefined>(undefined);
    const [galleryIndex, setGalleryIndex] = React.useState<number | undefined>(undefined);
    const [documentPreview, setDocumentPreview] = React.useState<ArtifactAction | undefined>(undefined);

    React.useEffect(() => {
        let cancelled = false;
        promptAttachmentsList(sessionId)
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
    }, [sessionId]);

    const galleryImages = React.useMemo<GalleryImage[]>(
        () => (listing?.items ?? []).flatMap((item) => isImage(item)
            ? [{ id: item.id, title: item.title, subtitle: item.subtitle, action: item.action }]
            : []),
        [listing],
    );
    const galleryById = React.useMemo(() => new Map(galleryImages.map((image, index) => [image.id, index])), [galleryImages]);
    const galleryWidth = Math.min(220, Math.max(132, (width - 40) / 2));
    const plain = React.useMemo(() => (listing?.items ?? []).filter((item) => !isImage(item)), [listing]);

    const openItem = React.useCallback((item: PromptAttachmentItem) => {
        // Images open the gallery; rich documents open inline; anything else
        // downloads exactly like the retired pill's tap did.
        if (isImage(item)) {
            const index = galleryById.get(item.id);
            if (index !== undefined) setGalleryIndex(index);
            return;
        }
        if (richPreviewKind(item.action.name) !== null) {
            setDocumentPreview(item.action);
            return;
        }
        void downloadArtifact(sessionId, {
            id: item.action.id,
            name: item.action.name,
            mimeType: item.action.mimeType,
            size: item.action.size,
        });
    }, [galleryById, sessionId]);

    return (
        <>
            <Stack.Screen options={{ title: 'Attachments' }} />
            <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
                {loading
                    ? <ActivityIndicator color={theme.colors.textSecondary} />
                    : error !== undefined
                        ? <Text style={{ color: theme.colors.textDestructive, fontSize: 14 }}>{error}</Text>
                        : <>
                            {galleryImages.length > 0 && (
                                <View style={styles.imageGrid}>
                                    {galleryImages.map((image, index) => (
                                        <View key={image.id} style={{ width: galleryWidth }}>
                                            <ArtifactThumbnail
                                                sessionId={sessionId}
                                                image={image}
                                                onPress={() => setGalleryIndex(index)}
                                            />
                                        </View>
                                    ))}
                                </View>
                            )}
                            {plain.map((item) => (
                                <Pressable
                                    key={item.id}
                                    accessibilityRole="button"
                                    accessibilityLabel={`Attachment ${item.title}, ${item.subtitle}`}
                                    onPress={() => openItem(item)}
                                    style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.colors.surfacePressed }]}
                                >
                                    <View style={[styles.iconTile, { backgroundColor: theme.colors.accentSubtle }]}>
                                        <Ionicons name={item.icon as never} size={16} color={theme.colors.textSecondary} />
                                    </View>
                                    <View style={{ flex: 1 }}>
                                        <Text style={{ color: theme.colors.text, fontSize: 15, fontWeight: '500' }} numberOfLines={1}>{item.title}</Text>
                                        <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 1 }} numberOfLines={1}>{item.subtitle}</Text>
                                    </View>
                                    <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                                </Pressable>
                            ))}
                            {(listing?.items.length ?? 0) === 0 && <Text style={{ color: theme.colors.textSecondary, fontSize: 14 }}>No attachments</Text>}
                        </>}
            </ScrollView>
            {documentPreview !== undefined && (
                <RichArtifactPreview sessionId={sessionId} artifact={documentPreview} onClose={() => setDocumentPreview(undefined)} />
            )}
            {galleryIndex !== undefined && (
                <ArtifactGallery sessionId={sessionId} images={galleryImages} initialIndex={galleryIndex} onClose={() => setGalleryIndex(undefined)} />
            )}
        </>
    );
}

const styles = StyleSheet.create({
    screen: { flex: 1 },
    content: { padding: 16, gap: 4 },
    imageGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
    row: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 4, paddingVertical: 8, borderRadius: 8 },
    iconTile: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
