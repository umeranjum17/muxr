import * as React from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, Text, View, useWindowDimensions, type ViewToken } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { downloadAttachment } from '@/utils/downloadAttachment';
import { Modal as AppModal } from '@/modal';
import { attachmentPreview, type AttachmentAction, type AttachmentPreviewSource } from '@/utils/attachmentPreview';

export interface GalleryImage {
    id: string;
    title: string;
    subtitle?: string;
    action: AttachmentAction;
}

const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;

export function AttachmentThumbnail({ sessionId, image, onPress, enabled = true }: { sessionId: string; image: GalleryImage; onPress: () => void; enabled?: boolean }) {
    // A grid preview is convenience, not permission to pull a 200 MB original.
    const preview = useAttachmentPreview(sessionId, image.action, enabled && image.action.size <= MAX_THUMBNAIL_BYTES);
    const [failed, setFailed] = React.useState(false);
    React.useEffect(() => setFailed(false), [image.id]);
    return (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Open ${image.title}`}
            style={({ pressed }) => [styles.thumbnail, pressed && styles.pressed]}>
            {!enabled || image.action.size > MAX_THUMBNAIL_BYTES
                ? <Ionicons name="image-outline" size={22} color="rgba(255,255,255,0.38)" />
                : preview === undefined
                  ? <ActivityIndicator color="rgba(255,255,255,0.45)" />
                  : preview === null || failed
                  ? <Ionicons name="image-outline" size={22} color="rgba(255,255,255,0.38)" />
                  : <Image source={{ uri: preview.uri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={120} recyclingKey={image.id} onError={() => setFailed(true)} />}
            <LinearGradient pointerEvents="none" colors={['transparent', 'rgba(0,0,0,0.8)']} locations={[0.25, 1]} style={styles.thumbnailShade} />
            <View style={styles.thumbnailCaption}>
                <Text numberOfLines={1} style={styles.thumbnailName}>{image.title}</Text>
                {image.subtitle !== undefined && <Text style={styles.thumbnailMeta}>{image.subtitle}</Text>}
            </View>
        </Pressable>
    );
}

export function AttachmentGallery({ sessionId, images, initialIndex, onClose }: {
    sessionId: string;
    images: GalleryImage[];
    initialIndex: number;
    onClose: () => void;
}) {
    const insets = useSafeAreaInsets();
    const { width, height } = useWindowDimensions();
    const list = React.useRef<FlatList<GalleryImage>>(null);
    const [index, setIndex] = React.useState(initialIndex);
    const [downloading, setDownloading] = React.useState(false);
    const active = images[index] ?? images[0];
    const viewabilityConfig = React.useRef({ itemVisiblePercentThreshold: 60 }).current;
    const onViewableItemsChanged = React.useRef(({ viewableItems }: { viewableItems: ViewToken<GalleryImage>[] }) => {
        const next = viewableItems[0]?.index;
        if (next !== null && next !== undefined) setIndex(next);
    }).current;

    React.useEffect(() => {
        requestAnimationFrame(() => list.current?.scrollToIndex({ index: initialIndex, animated: false }));
    }, [initialIndex]);

    if (active === undefined) return null;
    return (
        <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
            <View style={styles.gallery}>
                <View style={[styles.galleryHeader, { paddingTop: Math.max(insets.top, 12) }]}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                        <Text numberOfLines={1} style={styles.galleryName}>{active.title}</Text>
                        <Text style={styles.galleryCount}>{index + 1} / {images.length}</Text>
                    </View>
                    <Pressable disabled={downloading} onPress={() => {
                        setDownloading(true);
                        void downloadAttachment(sessionId, { ...active.action, mimeType: active.action.mimeType ?? 'application/octet-stream', at: 0 })
                            .catch((error: unknown) => AppModal.alert('Download failed', error instanceof Error ? error.message : String(error)))
                            .finally(() => setDownloading(false));
                    }} accessibilityRole="button" accessibilityLabel={`Download ${active.title}`} style={({ pressed }) => [styles.galleryControl, pressed && styles.pressed]}>
                        {downloading ? <ActivityIndicator color="#fff" /> : <Ionicons name="download-outline" size={21} color="#fff" />}
                    </Pressable>
                    <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close gallery" style={({ pressed }) => [styles.galleryControl, pressed && styles.pressed]}>
                        <Ionicons name="close" size={22} color="#fff" />
                    </Pressable>
                </View>
                <FlatList
                    ref={list}
                    data={images}
                    keyExtractor={(item) => item.id}
                    horizontal
                    pagingEnabled
                    initialNumToRender={1}
                    maxToRenderPerBatch={2}
                    windowSize={3}
                    showsHorizontalScrollIndicator={false}
                    getItemLayout={(_, itemIndex) => ({ length: width, offset: width * itemIndex, index: itemIndex })}
                    initialScrollIndex={initialIndex}
                    onScrollToIndexFailed={() => undefined}
                    viewabilityConfig={viewabilityConfig}
                    onViewableItemsChanged={onViewableItemsChanged}
                    renderItem={({ item, index: itemIndex }) => <GalleryPage sessionId={sessionId} image={item} width={width} height={height} active={itemIndex === index} />}
                />
                {images.length > 1 && images.length <= 12 && <View style={[styles.dots, { paddingBottom: Math.max(insets.bottom, 16) }]}>
                    {images.map((image, dot) => <Pressable key={image.id} onPress={() => list.current?.scrollToIndex({ index: dot })} hitSlop={6} accessibilityLabel={`Show image ${dot + 1}`}
                        style={[styles.dot, dot === index && styles.dotActive]} />)}
                </View>}
            </View>
        </Modal>
    );
}

function GalleryPage({ sessionId, image, width, height, active }: { sessionId: string; image: GalleryImage; width: number; height: number; active: boolean }) {
    // FlatList keeps neighbour pages mounted for smooth swiping; only the page
    // actually on screen is allowed to ask the host for bytes.
    const preview = useAttachmentPreview(sessionId, image.action, active);
    const [failed, setFailed] = React.useState(false);
    React.useEffect(() => setFailed(false), [image.id]);
    return <View style={{ width, height, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 86 }}>
        {!active
            ? null
            : preview === undefined
              ? <ActivityIndicator color="rgba(255,255,255,0.6)" />
            : preview === null || failed
              ? <Ionicons name="image-outline" size={34} color="rgba(255,255,255,0.32)" />
              : <Image source={{ uri: preview.uri }} style={{ width: '100%', height: '100%' }} contentFit="contain" transition={160} recyclingKey={image.id} onError={() => setFailed(true)} />}
    </View>;
}

function useAttachmentPreview(sessionId: string, action: AttachmentAction, enabled = true): AttachmentPreviewSource | null | undefined {
    const [source, setSource] = React.useState<AttachmentPreviewSource | null>();
    React.useEffect(() => {
        let alive = true;
        let loaded: AttachmentPreviewSource | undefined;
        setSource(undefined);
        if (!enabled) return () => { alive = false; };
        void attachmentPreview(sessionId, action).then((next) => {
            loaded = next;
            if (alive) setSource(next); else next.dispose?.();
        }).catch(() => { if (alive) setSource(null); });
        return () => { alive = false; loaded?.dispose?.(); };
    }, [action.id, action.name, action.size, enabled, sessionId]);
    return source;
}

const styles = StyleSheet.create({
    thumbnail: { aspectRatio: 1.25, borderRadius: 14, overflow: 'hidden', backgroundColor: '#151619', alignItems: 'center', justifyContent: 'center' },
    thumbnailShade: { ...StyleSheet.absoluteFillObject, top: '30%' },
    thumbnailCaption: { position: 'absolute', left: 10, right: 10, bottom: 9 },
    thumbnailName: { color: '#fff', fontSize: 12, lineHeight: 15, ...Typography.default('semiBold') },
    thumbnailMeta: { color: 'rgba(255,255,255,0.62)', fontSize: 10, marginTop: 1, ...Typography.mono() },
    pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
    gallery: { flex: 1, backgroundColor: '#050506' },
    galleryHeader: { position: 'absolute', zIndex: 2, left: 12, right: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
    galleryName: { color: '#fff', fontSize: 13, ...Typography.default('semiBold') },
    galleryCount: { color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 2, ...Typography.mono() },
    galleryControl: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.1)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.14)' },
    dots: { position: 'absolute', bottom: 0, left: 16, right: 16, flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: 5 },
    dot: { width: 4, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.25)' },
    dotActive: { width: 14, backgroundColor: 'rgba(255,255,255,0.9)' },
});
