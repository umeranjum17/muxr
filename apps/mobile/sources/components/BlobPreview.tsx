/**
 * Full-screen preview for non-image, non-text attachments — native stub.
 *
 * The shipped target today is the web export (see BlobPreview.web.tsx: HTML5
 * video + pdf.js). Native isn't cut yet; when it is, video plays in the system
 * WebView player and iOS renders PDFs natively. Android PDF needs the pdf.js
 * WebView treatment — add when the
 * first native build lands.
 */
import * as React from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import WebView from 'react-native-webview';
import { Typography } from '@/constants/Typography';
import type { BlobPreviewProps } from './BlobPreview.web';

export function BlobPreview({ name, localUri, onClose }: BlobPreviewProps) {
    return (
        <Modal transparent animationType="fade" onRequestClose={onClose} visible>
            <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.94)' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 18 }}>
                    <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: 'rgba(255,255,255,0.85)', fontSize: 12, ...Typography.mono() }}>
                        {name}
                    </Text>
                    <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close preview">
                        <Ionicons name="close" size={22} color="#fff" />
                    </Pressable>
                </View>
                <WebView source={{ uri: localUri }} style={{ flex: 1, backgroundColor: 'transparent' }} allowsFullscreenVideo />
            </View>
        </Modal>
    );
}
