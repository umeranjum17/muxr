/**
 * Full-screen preview for non-image, non-text attachments — web implementation.
 *
 * Videos play in a plain HTML5 <video> (the browser's own player, gestures and
 * all). PDFs render through pdf.js, lazily imported so the main bundle never
 * pays for it; the worker is served from /pdf.worker.min.mjs (see
 * scripts in package.json: setup-pdfjs). Metro picks BlobPreview.tsx on native.
 */
import * as React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { blobObjectUrl, readBlobBytes } from '@/utils/attachmentBlobs';
import { Typography } from '@/constants/Typography';

export interface BlobPreviewProps {
    name: string;
    mimeType: string;
    /** Content-hash id in the blob store (web renders from bytes). */
    blobId: string;
    /** Filesystem/data URI (native renders from the file). */
    localUri: string;
    onClose: () => void;
}

/** pdf.js renders pages one by one; cap so a 400-page dump can't hang the sheet. */
const MAX_PDF_PAGES = 50;

export function BlobPreview({ name, mimeType, blobId, onClose }: BlobPreviewProps) {
    const { theme } = useUnistyles();
    const isVideo = mimeType.startsWith('video/');
    const isPdf = mimeType === 'application/pdf';

    return (
        <Modal transparent animationType="fade" onRequestClose={onClose} visible>
            <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.94)', alignItems: 'center', justifyContent: 'center' }}>
                <View style={{ position: 'absolute', top: 18, left: 18, right: 18, flexDirection: 'row', alignItems: 'center', gap: 10, zIndex: 1 }}>
                    <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: 'rgba(255,255,255,0.85)', fontSize: 12, ...Typography.mono() }}>
                        {name}
                    </Text>
                    <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close preview">
                        <Ionicons name="close" size={22} color="#fff" />
                    </Pressable>
                </View>
                {isVideo && <VideoBody blobId={blobId} mimeType={mimeType} />}
                {isPdf && <PdfBody blobId={blobId} />}
                {!isVideo && !isPdf && (
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>No preview for this file type.</Text>
                )}
            </View>
        </Modal>
    );
}

function VideoBody({ blobId, mimeType }: { blobId: string; mimeType: string }) {
    const [url, setUrl] = React.useState<string | null>(null);
    React.useEffect(() => {
        let cancelled = false;
        void blobObjectUrl(blobId).then((found: string | null) => {
            if (!cancelled) setUrl(found);
        });
        return () => {
            cancelled = true;
        };
    }, [blobId]);
    if (url === null) return <ActivityIndicator color="#fff" />;
    // A real DOM video element: the browser's player, seek bar, volume, speed.
    return (
        <video
            src={url}
            controls
            autoPlay
            playsInline
            style={{ maxWidth: '96vw', maxHeight: '82vh', borderRadius: 10, backgroundColor: '#000' }}
        />
    );
}

function PdfBody({ blobId }: { blobId: string }) {
    const [pages, setPages] = React.useState<string[]>([]);
    const [total, setTotal] = React.useState<number | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        let cancelled = false;
        void (async () => {
            const bytes = await readBlobBytes(blobId);
            if (bytes === null) {
                if (!cancelled) setError('File not downloaded yet.');
                return;
            }
            try {
                const pdfjs = await import('pdfjs-dist/legacy/build/pdf.min.mjs');
                pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
                const doc = await pdfjs.getDocument({ data: bytes }).promise;
                if (cancelled) return;
                setTotal(doc.numPages);
                const rendered: string[] = [];
                for (let pageNumber = 1; pageNumber <= Math.min(doc.numPages, MAX_PDF_PAGES); pageNumber += 1) {
                    const page = await doc.getPage(pageNumber);
                    const viewport = page.getViewport({ scale: 2 });
                    const canvas = document.createElement('canvas');
                    canvas.width = viewport.width;
                    canvas.height = viewport.height;
                    const context = canvas.getContext('2d');
                    if (context === null) break;
                    await page.render({ canvasContext: context, viewport, canvas }).promise;
                    rendered.push(canvas.toDataURL('image/jpeg', 0.85));
                    if (cancelled) return;
                    setPages([...rendered]);
                }
            } catch (caught) {
                if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [blobId]);

    if (error !== null) return <Text style={{ color: '#f88', fontSize: 13, padding: 20 }}>{error}</Text>;
    return (
        <ScrollView style={{ width: '100%' }} contentContainerStyle={{ alignItems: 'center', gap: 10, paddingTop: 52, paddingBottom: 30 }}>
            {pages.map((dataUrl, index) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={index} src={dataUrl} alt={`page ${index + 1}`} style={{ width: '94%', maxWidth: 900, borderRadius: 6 }} />
            ))}
            {pages.length === 0 && <ActivityIndicator color="#fff" />}
            {total !== null && (
                <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11, ...Typography.mono() }}>
                    {total > MAX_PDF_PAGES ? `first ${MAX_PDF_PAGES} of ${total} pages` : `${total} page${total === 1 ? '' : 's'}`}
                </Text>
            )}
        </ScrollView>
    );
}
