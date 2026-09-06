import * as React from 'react';
import { ActivityIndicator, Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { readRichAttachment } from '@/utils/richAttachmentPreview';
import { richPreviewHtml } from '@/utils/richPreviewHtml';
import type { AttachmentAction } from '@/utils/attachmentPreview';
import { downloadAttachment } from '@/utils/downloadAttachment';
import { loadPreviewRuntime } from './loadPreviewRuntime';
import { PreviewSurface } from './PreviewSurface';

export function RichAttachmentPreview({ sessionId, attachment, onClose }: { sessionId: string; attachment: AttachmentAction; onClose: () => void }) {
    const insets = useSafeAreaInsets();
    const [html, setHtml] = React.useState<string>();
    const [error, setError] = React.useState<string>();
    const [downloading, setDownloading] = React.useState(false);
    React.useEffect(() => {
        const controller = new AbortController();
        setHtml(undefined); setError(undefined);
        void Promise.all([loadPreviewRuntime(), readRichAttachment(sessionId, attachment, controller.signal)])
            .then(([runtime, payload]) => { if (!controller.signal.aborted) setHtml(richPreviewHtml(runtime, payload)); })
            .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Preview unavailable.'); });
        return () => controller.abort();
    }, [sessionId, attachment.id, attachment.name, attachment.size]);
    const buttonStyle = { minWidth: 44, minHeight: 44, justifyContent: 'center' as const, paddingHorizontal: 12 };
    return <Modal visible animationType="slide" onRequestClose={onClose}>
        <View style={{ flex: 1, backgroundColor: '#fff', paddingTop: insets.top, paddingBottom: insets.bottom }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#ddd', paddingHorizontal: 8 }}>
                <Text numberOfLines={1} style={{ flex: 1, color: '#202329', fontSize: 14, padding: 8 }}>{attachment.name}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="Download original" disabled={downloading} style={buttonStyle} onPress={() => {
                    setDownloading(true);
                    void downloadAttachment(sessionId, { ...attachment, mimeType: attachment.mimeType ?? 'application/octet-stream', at: 0 })
                        .catch(() => setError('Download failed. Check the connection and try again.')).finally(() => setDownloading(false));
                }}>{downloading ? <ActivityIndicator /> : <Text style={{ color: '#235fc2' }}>Download</Text>}</Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="Close document preview" onPress={onClose} style={buttonStyle}><Text style={{ color: '#235fc2' }}>Close</Text></Pressable>
            </View>
            {error ? <Text accessibilityRole="alert" style={{ color: '#743a22', padding: 24 }}>{error}</Text>
                : html ? <PreviewSurface html={html} onError={() => setError('The preview stopped. Download the original or reopen it.')} />
                    : <ActivityIndicator accessibilityLabel="Opening document preview" style={{ flex: 1 }} />}
        </View>
    </Modal>;
}
