import * as React from 'react';
import { ActivityIndicator, Keyboard, Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { ZoomableAttachmentImage } from './ZoomableAttachmentImage';

export interface ComposerAttachment {
    id: string;
    uri: string;
    name: string;
    path?: string;
}

/** Local picker previews remain visible after upload; only host paths are sent. */
export function ComposerAttachments({ images, onRemove }: {
    images: readonly ComposerAttachment[];
    onRemove: (id: string) => void;
}) {
    const { theme } = useUnistyles();
    const { width, height } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const [previewId, setPreviewId] = React.useState<string>();
    const [failed, setFailed] = React.useState(false);
    const preview = images.find((image) => image.id === previewId);
    const ignoreZoom = React.useCallback(() => {}, []);
    if (images.length === 0) return null;
    return <>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always"
            style={{ maxHeight: 124 }} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8, gap: 10 }}>
            {images.map((image) => <View key={image.id} style={{ width: 92 }}>
                <Pressable accessibilityRole="button" accessibilityLabel={`Preview attachment ${image.name}`}
                    onPress={() => { Keyboard.dismiss(); setFailed(false); setPreviewId(image.id); }}
                    style={{ width: 92, height: 88, borderRadius: 12, overflow: 'hidden', backgroundColor: theme.colors.surfaceHigh }}>
                    <Image source={{ uri: image.uri }} recyclingKey={image.id} contentFit="cover" style={{ width: 92, height: 88 }} />
                    {image.path === undefined && <View pointerEvents="none" style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)' }}>
                        <ActivityIndicator color="#fff" accessibilityLabel={`Uploading ${image.name}`} />
                    </View>}
                </Pressable>
                {image.path !== undefined && <Pressable accessibilityRole="button" accessibilityLabel={`Remove attachment ${image.name}`}
                    onPress={() => onRemove(image.id)} hitSlop={2}
                    style={{ position: 'absolute', top: 0, right: 0, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                    <View style={{ borderRadius: 16, width: 28, height: 28, backgroundColor: 'rgba(0,0,0,0.8)', alignItems: 'center', justifyContent: 'center' }}>
                        <Ionicons name="close" size={20} color="#fff" />
                    </View>
                </Pressable>}
                <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, marginTop: 4, fontSize: 11 }}>{image.name}</Text>
            </View>)}
        </ScrollView>
        {preview !== undefined && <Modal visible animationType="fade" onRequestClose={() => setPreviewId(undefined)}>
            <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#111', paddingTop: insets.top, paddingBottom: insets.bottom }}>
                <View style={{ minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingLeft: 16 }}>
                    <Text numberOfLines={1} style={{ flex: 1, color: '#fff', fontSize: 16 }}>{preview.name}</Text>
                    <Pressable accessibilityRole="button" accessibilityLabel="Close attachment preview" onPress={() => setPreviewId(undefined)}
                        style={{ width: 56, height: 56, alignItems: 'center', justifyContent: 'center' }}>
                        <Ionicons name="close" size={24} color="#fff" />
                    </Pressable>
                </View>
                {failed ? <Text style={{ color: '#fff', padding: 24 }}>This image preview is unavailable.</Text>
                    : <ZoomableAttachmentImage uri={preview.uri} recyclingKey={preview.id} width={width} height={Math.max(1, height - insets.top - insets.bottom - 56)}
                        onError={() => setFailed(true)} onZoomedChange={ignoreZoom} />}
            </GestureHandlerRootView>
        </Modal>}
    </>;
}
