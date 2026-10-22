/**
 * Prompt-attachment picker hook for the composer: images from the photo
 * library or the camera, and any other file from the system document picker.
 *
 * Images keep their own path — permission, resize to the model's edge, JPEG
 * re-encode, thumbhash preview. Files are taken as-is with their original
 * name, type and size. Both obey one per-file cap and one per-message count.
 *
 * Note: a picker that cannot report a file's size returns undefined → size=0;
 * that file passes the client-side check and the host enforces the cap again
 * on upload.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { Platform } from 'react-native';
import { Modal } from '@/modal';
import { generateThumbhash } from '@/utils/thumbhash';
import { t } from '@/text';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, type AttachmentPreview } from '@/catalog/infrastructure/attachmentTypes';

const MAX_MB = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024));
const ATTACHMENT_JPEG_QUALITY = 0.8;
// The host resizes to this before handing images to the model, so anything
// bigger is bytes we base64, encrypt and ship for nothing.
const MAX_ATTACHMENT_EDGE = 1568;

export type { AttachmentPreview };

type UseAttachmentPickerResult = {
    attachments: AttachmentPreview[];
    pickImages: () => Promise<void>;
    takePhoto: () => Promise<void>;
    pickFiles: () => Promise<void>;
    removeAttachment: (id: string) => void;
    clearAttachments: () => void;
    /** Queues files picked elsewhere, such as a first prompt handed back after it failed. */
    addAttachments: (previews: AttachmentPreview[]) => void;
};

function newId(): string {
    return `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function withJpegPlugin(fileName: string | null | undefined): string {
    const fallback = `image_${Date.now()}.jpg`;
    const name = fileName?.trim() || fallback;
    const extensionIndex = name.lastIndexOf('.');
    const stem = extensionIndex > 0 ? name.slice(0, extensionIndex) : name;
    return `${stem}.jpg`;
}

export async function normalizePickedAssetForUpload(asset: ImagePicker.ImagePickerAsset): Promise<{
    uri: string;
    width: number;
    height: number;
    mimeType: string;
    name: string;
}> {
    if (Platform.OS === 'web') {
        return {
            uri: asset.uri,
            width: asset.width,
            height: asset.height,
            mimeType: asset.mimeType ?? 'image/jpeg',
            name: asset.fileName ?? `image_${Date.now()}.jpg`,
        };
    }

    const longestEdge = Math.max(asset.width, asset.height);
    const actions = longestEdge > MAX_ATTACHMENT_EDGE
        ? [{
            resize: asset.width >= asset.height
                ? { width: MAX_ATTACHMENT_EDGE }
                : { height: MAX_ATTACHMENT_EDGE },
        }]
        : [];

    const converted = await manipulateAsync(asset.uri, actions, {
        compress: ATTACHMENT_JPEG_QUALITY,
        format: SaveFormat.JPEG,
    });

    return {
        uri: converted.uri,
        width: converted.width || asset.width,
        height: converted.height || asset.height,
        mimeType: 'image/jpeg',
        name: withJpegPlugin(asset.fileName),
    };
}

/** One plain refusal, naming the file and the cap, for anything too big. */
function rejectTooLarge(name: string): void {
    Modal.alert(
        t('imageUpload.fileTooLargeTitle'),
        t('imageUpload.fileTooLargeMessage', { name, maxMb: MAX_MB }),
        [{ text: t('common.ok') }],
    );
}

function rejectLimit(): void {
    Modal.alert(
        t('imageUpload.limitTitle'),
        t('imageUpload.limitMessage', { max: MAX_ATTACHMENTS_PER_MESSAGE }),
        [{ text: t('common.ok') }],
    );
}

/**
 * One attach control on each composer offers both sources, so the rail keeps
 * its geometry at 270 dp. Plain words, matching the button's own label.
 */
export function chooseAttachmentSource({ pickImages, takePhoto, pickFiles }: Pick<UseAttachmentPickerResult, 'pickImages' | 'takePhoto' | 'pickFiles'>): void {
    Modal.alert('Add attachment', undefined, [
        { text: 'Photo library', icon: 'images-outline', onPress: () => void pickImages() },
        { text: 'Camera', icon: 'camera-outline', onPress: () => void takePhoto() },
        { text: 'Files', icon: 'document-outline', onPress: () => void pickFiles() },
        { text: t('common.cancel'), style: 'cancel' },
    ]);
}

export function useAttachmentPicker(): UseAttachmentPickerResult {
    const [attachments, setAttachments] = useState<AttachmentPreview[]>([]);
    // Ref tracks current count to avoid stale closures on rapid taps.
    const selectedCountRef = useRef(0);
    useEffect(() => {
        selectedCountRef.current = attachments.length;
    }, [attachments]);

    const requestPermission = useCallback(async (camera: boolean): Promise<boolean> => {
        if (Platform.OS === 'web') return true;

        const { status } = camera
            ? await ImagePicker.requestCameraPermissionsAsync()
            : await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== 'granted') {
            if (camera) Modal.alert('Camera is off', 'Turn on Camera for muxr in Settings to take a photo.');
            else Modal.alert(t('imageUpload.permissionTitle'), t('imageUpload.permissionMessage'), [{ text: t('common.ok') }]);
            return false;
        }
        return true;
    }, []);

    const addImages = useCallback(async (camera: boolean) => {
        const hasPermission = await requestPermission(camera);
        if (!hasPermission) return;

        const remaining = MAX_ATTACHMENTS_PER_MESSAGE - selectedCountRef.current;
        if (remaining <= 0) {
            rejectLimit();
            return;
        }

        const result = camera
            ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1, exif: false })
            : await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ['images'], // expo-image-picker ~55: MediaTypeOptions deprecated
                allowsMultipleSelection: true,
                selectionLimit: remaining,
                quality: 1, // request full-resolution source; iOS upload is normalized below
                exif: false,
            });

        if (result.canceled || !result.assets.length) return;

        // On web, selectionLimit is not enforced by the browser — clamp here.
        const assets = result.assets.slice(0, remaining);
        const previews: AttachmentPreview[] = [];

        for (const asset of assets) {
            const size = asset.fileSize ?? 0;

            if (size > MAX_ATTACHMENT_BYTES) {
                rejectTooLarge(asset.fileName ?? 'image');
                continue;
            }

            const normalized = await normalizePickedAssetForUpload(asset);

            // Skip thumbhash if dimensions are unavailable (prevents divide-by-zero).
            const thumbhash = (normalized.width > 0 && normalized.height > 0)
                ? await generateThumbhash(normalized.uri, normalized.width, normalized.height)
                : undefined;

            previews.push({
                id: newId(),
                uri: normalized.uri,
                width: normalized.width,
                height: normalized.height,
                mimeType: normalized.mimeType,
                size,
                name: normalized.name,
                thumbhash,
            });
        }

        if (previews.length > 0) {
            setAttachments(prev => [...prev, ...previews].slice(0, MAX_ATTACHMENTS_PER_MESSAGE));
        }
    }, [requestPermission]);
    const pickImages = useCallback(() => addImages(false), [addImages]);
    const takePhoto = useCallback(() => addImages(true), [addImages]);

    const pickFiles = useCallback(async () => {
        const remaining = MAX_ATTACHMENTS_PER_MESSAGE - selectedCountRef.current;
        if (remaining <= 0) {
            rejectLimit();
            return;
        }

        // Imported on demand so the document-picker native module stays out of
        // the landing payload; it loads only when Files is tapped.
        const DocumentPicker = await import('expo-document-picker');
        const result = await DocumentPicker.getDocumentAsync({
            type: '*/*',
            multiple: true,
            copyToCacheDirectory: true, // native: file:// the filesystem can read
            base64: false, // web: a blob URL, not a second copy of the bytes
        });
        if (result.canceled || !result.assets.length) return;

        // The browser ignores selection limits — clamp the same way images do.
        const assets = result.assets.slice(0, remaining);
        const previews: AttachmentPreview[] = [];
        for (const asset of assets) {
            const size = asset.size ?? 0;
            if (size > MAX_ATTACHMENT_BYTES) {
                rejectTooLarge(asset.name);
                continue;
            }
            previews.push({
                id: newId(),
                uri: asset.uri,
                mimeType: asset.mimeType ?? 'application/octet-stream',
                size,
                name: asset.name,
            });
        }

        if (previews.length > 0) {
            setAttachments(prev => [...prev, ...previews].slice(0, MAX_ATTACHMENTS_PER_MESSAGE));
        }
    }, []);

    const removeAttachment = useCallback((id: string) => {
        setAttachments(prev => prev.filter(attachment => attachment.id !== id));
    }, []);

    const clearAttachments = useCallback(() => {
        setAttachments([]);
    }, []);

    const addAttachments = useCallback((previews: AttachmentPreview[]) => {
        setAttachments(prev => [...prev, ...previews].slice(0, MAX_ATTACHMENTS_PER_MESSAGE));
    }, []);

    return { attachments, pickImages, takePhoto, pickFiles, removeAttachment, clearAttachments, addAttachments };
}
