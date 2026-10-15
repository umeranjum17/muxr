/**
 * Shared types for the prompt-attachment pipeline: images and any other file.
 * Defined here (not in hooks/) to avoid circular dependencies:
 * hooks/ imports from sync/, so sync/ cannot import from hooks/.
 */

export type AttachmentPreview = {
    /** Stable unique identifier for use as React key and for removal. */
    id: string;
    uri: string;
    /** Image dimensions; absent for a non-image file. */
    width?: number;
    height?: number;
    mimeType: string;
    /** May be 0 if the system did not provide the file size. */
    size: number;
    name: string;
    thumbhash?: string;
};

/**
 * One per-file cap for anything the phone sends, images included. 10 MB matches
 * the image cap this replaces; base64 grows it to ~13.4 MB, still inside the
 * link's 16 MB per-message reassembly ceiling, and each file goes in its own
 * request so a batch never approaches that ceiling.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const MAX_ATTACHMENTS_PER_MESSAGE = 20;

export function isImageAttachment(attachment: Pick<AttachmentPreview, 'mimeType'>): boolean {
    return attachment.mimeType.startsWith('image/');
}
