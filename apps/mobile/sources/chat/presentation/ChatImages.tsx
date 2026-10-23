import * as React from 'react';
import { ActivityIndicator, Modal, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import type { ChatImage } from '@trymuxr/contract';
import { chatImage } from '@/catalog/ops';
import { ZoomableImage } from '@/components/ZoomableImage';
import { humanError } from '@/utils/errors';

/** An image in the column is never taller than this; tap opens it whole. */
const MAX_HEIGHT = 260;
/** Images already fetched, so a poll that redraws the chat never fetches them again. */
const CACHE_MAX = 60;
const fetched = new Map<string, Promise<string | null>>();

type Loaded = { uri: string } | { error: string } | undefined;

function load(sessionId: string, id: string): Promise<string | null> {
    const key = `${sessionId}\n${id}`;
    let pending = fetched.get(key);
    if (pending === undefined) {
        pending = chatImage(sessionId, id).then((image) => image === null ? null : `data:${image.mimeType};base64,${image.data}`);
        // A failed fetch is asked again next time; only an answer is kept.
        pending.catch(() => fetched.delete(key));
        fetched.set(key, pending);
        if (fetched.size > CACHE_MAX) fetched.delete(fetched.keys().next().value!);
    }
    return pending;
}

function useImage(sessionId: string, id: string): Loaded {
    const [loaded, setLoaded] = React.useState<Loaded>(undefined);
    React.useEffect(() => {
        let live = true;
        load(sessionId, id).then(
            (uri) => { if (live) setLoaded(uri === null ? { error: 'This image is gone from the computer or too big to show.' } : { uri }); },
            (error: unknown) => { if (live) setLoaded({ error: humanError(error).message }); },
        );
        return () => { live = false; };
    }, [sessionId, id]);
    return loaded;
}

function ImageCard({ sessionId, image, width, onOpen }: { sessionId: string; image: ChatImage; width: number; onOpen: (uri: string) => void }): React.JSX.Element {
    const { theme } = useUnistyles();
    const loaded = useImage(sessionId, image.id);
    const [ratio, setRatio] = React.useState(4 / 3);
    const height = Math.min(MAX_HEIGHT, width / ratio);
    const label = image.name === 'Image' ? 'image' : image.name;
    if (loaded !== undefined && 'error' in loaded) {
        return (
            <View accessible accessibilityLabel={`${label}: ${loaded.error}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: 14, backgroundColor: theme.colors.surfaceHighest }}>
                <Ionicons name="image-outline" size={18} color={theme.colors.textSecondary} />
                <Text style={{ flexShrink: 1, color: theme.colors.textSecondary, fontSize: 13 }}>{loaded.error}</Text>
            </View>
        );
    }
    return (
        <Pressable
            disabled={loaded === undefined}
            onPress={() => { if (loaded !== undefined) onOpen(loaded.uri); }}
            accessibilityRole="imagebutton"
            accessibilityLabel={`Open ${label}`}
            style={({ pressed }) => ({ padding: 6, borderRadius: 16, backgroundColor: theme.colors.surfaceHighest, opacity: pressed ? 0.7 : 1 })}
        >
            <View style={{ width: height * ratio, height, borderRadius: 11, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
                {loaded === undefined
                    ? <ActivityIndicator color={theme.colors.textSecondary} />
                    : <Image source={{ uri: loaded.uri }} style={{ width: '100%', height: '100%' }} contentFit="contain" recyclingKey={image.id}
                        onLoad={(event) => { if (event.source.width > 0 && event.source.height > 0) setRatio(event.source.width / event.source.height); }} />}
            </View>
        </Pressable>
    );
}

/** The images a message carries, each a card in the column; tap shows it full screen to zoom. */
export function ChatImages({ sessionId, images, mine }: { sessionId: string; images: ChatImage[]; mine: boolean }): React.JSX.Element {
    const [column, setColumn] = React.useState(0);
    const [open, setOpen] = React.useState<string | null>(null);
    return (
        <>
            <View onLayout={(event) => setColumn(event.nativeEvent.layout.width)} style={{ gap: 8, alignItems: mine ? 'flex-end' : 'flex-start' }}>
                {column > 0 && images.map((image) => <ImageCard key={image.id} sessionId={sessionId} image={image} width={Math.min(column * (mine ? 0.84 : 1), 520) - 12} onOpen={setOpen} />)}
            </View>
            <ImageViewer uri={open} onClose={() => setOpen(null)} />
        </>
    );
}

const ignoreZoom = () => {};

function ImageViewer({ uri, onClose }: { uri: string | null; onClose: () => void }): React.JSX.Element {
    const insets = useSafeAreaInsets();
    const { width, height } = useWindowDimensions();
    const [failed, setFailed] = React.useState(false);
    React.useEffect(() => setFailed(false), [uri]);
    return (
        <Modal visible={uri !== null} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
            <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#000', justifyContent: 'center' }}>
                {uri !== null && (failed
                    ? <Text style={{ color: '#fff', padding: 24, textAlign: 'center' }}>This image could not be shown.</Text>
                    : <ZoomableImage uri={uri} recyclingKey={uri.slice(-64)} width={width} height={Math.max(1, height - insets.top - insets.bottom)} onError={() => setFailed(true)} onZoomedChange={ignoreZoom} />)}
                <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close image" hitSlop={8}
                    style={({ pressed }) => ({ position: 'absolute', top: insets.top + 8, right: 12, width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255, 255, 255, 0.16)', opacity: pressed ? 0.7 : 1 })}>
                    <Ionicons name="close" size={22} color="#fff" />
                </Pressable>
            </GestureHandlerRootView>
        </Modal>
    );
}
