import * as React from 'react';
import { sync } from '@/catalog/sync';
import { useImagePicker, type AttachmentPreview } from '@/hooks/useImagePicker';
import { readFileBytes } from '@/utils/readFileBytes';
import { encodeBase64 } from '@/encryption/base64';
import type { ComposerAttachment } from '@/components/ComposerAttachments';
import { newSubmissionIdentity, useSubmissions, type SubmissionTarget } from '@/catalog/application/submissions';

/** Previews whose upload was overtaken by a target change stay recoverable on that target. */
function keepPendingUploads(target: SubmissionTarget, previews: AttachmentPreview[]): void {
    const identity = newSubmissionIdentity();
    useSubmissions.getState().put({
        ...target,
        id: identity.promptId,
        notValidAfter: identity.notValidAfter,
        text: '',
        draft: '',
        attachments: [],
        pendingUploads: previews,
        state: 'refused',
        reason: 'The computer changed while attaching. The files are kept for that computer; attach them again there.',
        noticed: false,
    });
}

/**
 * Attachments for one session: the picker's active queue uploads once; a
 * batch that fails moves to `failed`, where it is owned until an explicit
 * Retry re-queues it or Discard drops it. Failure and queue are separate
 * so keeping the files never turns into an automatic retry loop, and only
 * a batch that actually landed on the host leaves.
 */
export function useAttachmentUploads(machineId: string, sessionId: string, onFailure: (message: unknown) => void) {
    const { selectedImages, pickImages, clearImages, addImages } = useImagePicker();
    const [attaching, setAttaching] = React.useState(false);
    // Local previews stay visible after upload; only host paths are sent.
    const [attachedImages, setAttachedImages] = React.useState<ComposerAttachment[]>([]);
    const attachedPaths = React.useMemo(() => attachedImages.flatMap((image) => image.path === undefined ? [] : [image.path]), [attachedImages]);
    const [failed, setFailed] = React.useState<AttachmentPreview[]>([]);
    const onFailureRef = React.useRef(onFailure);
    onFailureRef.current = onFailure;
    // One opening of one target owns its uploads: bytes read for this
    // computer never go anywhere else once the screen moved on.
    const opening = React.useRef(0);
    React.useEffect(() => () => { opening.current += 1; }, [machineId, sessionId]);

    React.useEffect(() => {
        if (selectedImages.length === 0 || attaching) return;
        setAttaching(true);
        const batch = selectedImages;
        const target = { machineId, sessionId };
        const startedIn = opening.current;
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
                if (opening.current !== startedIn) {
                    // The screen left this target while reading: the previews
                    // wait on the owning computer's session, never sent here.
                    keepPendingUploads(target, batch);
                    return;
                }
                const result = await sync.saveAttachments(target.machineId, target.sessionId, attachments);
                if (result.savedPaths.length !== batch.length) throw new Error('The host did not confirm every image. Please attach them again.');
                setAttachedImages((previous) => [...previous, ...result.savedPaths.map((path, index) => ({
                    id: batch[index]!.id,
                    uri: batch[index]!.uri,
                    name: batch[index]!.name,
                    path,
                }))]);
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
    }, [selectedImages, attaching, clearImages, machineId, sessionId]);

    const retryFailed = React.useCallback(() => {
        setFailed((previous) => { addImages(previous); return []; });
    }, [addImages]);
    const discardFailed = React.useCallback(() => setFailed([]), []);

    return { attaching, selectedImages, attachedImages, setAttachedImages, attachedPaths, failed, retryFailed, discardFailed, pickImages, addImages };
}
