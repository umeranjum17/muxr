import * as React from 'react';
import { sync } from '@/catalog/sync';
import { useImagePicker, type AttachmentPreview } from '@/hooks/useImagePicker';
import { readFileBytes } from '@/utils/readFileBytes';
import { encodeBase64 } from '@/encryption/base64';

/**
 * Attachments for one session: the picker's active queue uploads once; a
 * batch that fails moves to `failed`, where it is owned until an explicit
 * Retry re-queues it or Discard drops it. Failure and queue are separate
 * so keeping the files never turns into an automatic retry loop, and only
 * a batch that actually landed on the host leaves.
 */
export function useAttachmentUploads(sessionId: string, onFailure: (message: unknown) => void) {
    const { selectedImages, pickImages, clearImages, addImages } = useImagePicker();
    const [attaching, setAttaching] = React.useState(false);
    const [attachedPaths, setAttachedPaths] = React.useState<string[]>([]);
    const [failed, setFailed] = React.useState<AttachmentPreview[]>([]);
    const onFailureRef = React.useRef(onFailure);
    onFailureRef.current = onFailure;

    React.useEffect(() => {
        if (selectedImages.length === 0 || attaching) return;
        setAttaching(true);
        const batch = selectedImages;
        void (async () => {
            try {
                const attachments = [];
                for (const image of batch) {
                    attachments.push({
                        name: image.name,
                        mimeType: image.mimeType,
                        data: encodeBase64(await readFileBytes(image.uri)),
                    });
                }
                const result = await sync.request('session.saveAttachments', { sessionId, attachments });
                if (result.savedPaths.length > 0) {
                    setAttachedPaths((previous) => [...previous, ...result.savedPaths]);
                }
            } catch (error) {
                setFailed((previous) => [...previous, ...batch.filter((image) => !previous.some((kept) => kept.id === image.id))]);
                onFailureRef.current(error);
            } finally {
                // In finally, not after the request: a failed upload with the
                // images still queued would re-fire this effect forever. The
                // failed batch was moved to `failed` first, so nothing is lost.
                clearImages();
                setAttaching(false);
            }
        })();
    }, [selectedImages, attaching, clearImages, sessionId]);

    const retryFailed = React.useCallback(() => {
        setFailed((previous) => { addImages(previous); return []; });
    }, [addImages]);
    const discardFailed = React.useCallback(() => setFailed([]), []);

    return { attaching, attachedPaths, setAttachedPaths, failed, retryFailed, discardFailed, pickImages, addImages };
}
