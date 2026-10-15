/**
 * Horizontal scrollable strip of the composer's chosen attachments.
 * Images show their thumbnail (with a thumbhash placeholder); any other file
 * shows a file-type icon with its name and size. Each has a remove button.
 */
import * as React from 'react';
import { ScrollView, View, Pressable, Text } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { attachmentIcon, attachmentSizeLabel, isImageAttachment, type AttachmentPreview } from '@/catalog';
import { thumbhashToDataUri } from '@/utils/thumbhash';

const THUMB_SIZE = 64;
const BORDER_RADIUS = 8;

interface AgentInputAttachmentStripProps {
    images: AttachmentPreview[];
    onRemove: (id: string) => void;
}

export function AgentInputAttachmentStrip({ images, onRemove }: AgentInputAttachmentStripProps) {
    const { theme } = useUnistyles();

    if (images.length === 0) return null;

    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.strip}
            contentContainerStyle={styles.stripContent}
            keyboardShouldPersistTaps="always"
        >
            {images.map((attachment) => (
                isImageAttachment(attachment)
                    ? <AttachmentThumbnail key={attachment.id} image={attachment} onRemove={onRemove} theme={theme} />
                    : <AttachmentFileChip key={attachment.id} attachment={attachment} onRemove={onRemove} theme={theme} />
            ))}
        </ScrollView>
    );
}

function AttachmentThumbnail({
    image,
    onRemove,
    theme,
}: {
    image: AttachmentPreview;
    onRemove: (id: string) => void;
    theme: any;
}) {
    // Build placeholder from thumbhash if available
    const placeholder = React.useMemo(() => {
        if (!image.thumbhash) return undefined;
        const uri = thumbhashToDataUri(image.thumbhash);
        return uri ? { uri } : undefined;
    }, [image.thumbhash]);

    return (
        <View style={[
            styles.thumbContainer,
            { borderColor: theme.colors.divider }
        ]}>
            <Image
                source={{ uri: image.uri }}
                placeholder={placeholder}
                style={[{ width: THUMB_SIZE, height: THUMB_SIZE }, styles.thumb]}
                contentFit="cover"
                transition={150}
            />
            {/* Remove button */}
            <Pressable
                onPress={() => onRemove(image.id)}
                hitSlop={4}
                style={(p) => [
                    styles.removeButton,
                    { backgroundColor: theme.colors.surfaceHigh, opacity: p.pressed ? 0.7 : 1 }
                ]}
            >
                <Ionicons name="close" size={10} color={theme.colors.text} />
            </Pressable>
        </View>
    );
}

function AttachmentFileChip({
    attachment,
    onRemove,
    theme,
}: {
    attachment: AttachmentPreview;
    onRemove: (id: string) => void;
    theme: any;
}) {
    const size = attachment.size > 0 ? attachmentSizeLabel(attachment.size) : '';
    return (
        <View style={[styles.fileChip, { borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh }]}>
            <Ionicons name={attachmentIcon(attachment)} size={20} color={theme.colors.textSecondary} />
            <View style={styles.fileText}>
                <Text numberOfLines={1} style={[styles.fileName, { color: theme.colors.text }]}>{attachment.name}</Text>
                {size !== '' && <Text numberOfLines={1} style={[styles.fileSize, { color: theme.colors.textSecondary }]}>{size}</Text>}
            </View>
            <Pressable
                onPress={() => onRemove(attachment.id)}
                hitSlop={4}
                accessibilityRole="button"
                accessibilityLabel={`Remove attachment ${attachment.name}`}
                style={(p) => [styles.fileRemove, { opacity: p.pressed ? 0.6 : 1 }]}
            >
                <Ionicons name="close" size={14} color={theme.colors.text} />
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    strip: {
        marginBottom: 8,
        marginHorizontal: 8,
    },
    stripContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 4,
    },
    thumbContainer: {
        width: THUMB_SIZE,
        height: THUMB_SIZE,
        borderRadius: BORDER_RADIUS,
        overflow: 'visible',
        borderWidth: 1,
        position: 'relative',
    },
    thumb: {
        borderRadius: BORDER_RADIUS,
    },
    removeButton: {
        position: 'absolute',
        top: -6,
        right: -6,
        width: 18,
        height: 18,
        borderRadius: 9,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10,
    },
    fileChip: {
        height: THUMB_SIZE,
        maxWidth: 220,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 10,
        borderRadius: BORDER_RADIUS,
        borderWidth: 1,
    },
    fileText: {
        flexShrink: 1,
        minWidth: 0,
    },
    fileName: {
        fontSize: 13,
    },
    fileSize: {
        fontSize: 11,
        marginTop: 1,
    },
    fileRemove: {
        width: 20,
        height: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
