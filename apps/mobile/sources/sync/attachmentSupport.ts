export type ImageAttachmentFlavor = string | null | undefined;

export type ImageAttachmentSendPlan = {
    supportsAttachments: boolean;
    shouldUseAttachments: boolean;
    shouldShowUnsupportedAlert: boolean;
    shouldSendText: boolean;
};

export function supportsImageAttachmentsForFlavor(flavor: ImageAttachmentFlavor): boolean {
    return !flavor || flavor === 'claude' || flavor === 'codex';
}

export function getImageAttachmentSendPlan(opts: {
    flavor: ImageAttachmentFlavor;
    text: string;
    attachmentCount: number;
    supportsAttachments?: boolean;
}): ImageAttachmentSendPlan {
    const hasAttachments = opts.attachmentCount > 0;
    const supportsAttachments = opts.supportsAttachments ?? supportsImageAttachmentsForFlavor(opts.flavor);
    const shouldShowUnsupportedAlert = hasAttachments && !supportsAttachments;

    return {
        supportsAttachments,
        shouldUseAttachments: hasAttachments && supportsAttachments,
        shouldShowUnsupportedAlert,
        shouldSendText: !shouldShowUnsupportedAlert || opts.text.trim().length > 0,
    };
}

export interface AttachmentHealPlan<T extends { id: string; size: number }> {
    candidates: T[];
    /** Permanently ineligible for whole-file healing during this mount. */
    unavailableIds: string[];
    /** Eligible on a later sheet opening after this opening's budget resets. */
    deferredIds: string[];
}

export function planAttachmentHeal<T extends { id: string; size: number }>(entries: readonly T[], maxAttempts = 8, maxBytes = 4 * 1024 * 1024, maxFetchBytes = 2 * 1024 * 1024): AttachmentHealPlan<T> {
    const candidates: T[] = [];
    const unavailableIds: string[] = [];
    const deferredIds: string[] = [];
    let bytes = 0;
    for (const entry of entries) {
        if (entry.size > maxFetchBytes) {
            unavailableIds.push(entry.id);
            continue;
        }
        if (candidates.length >= maxAttempts || entry.size > maxBytes - bytes) {
            deferredIds.push(entry.id);
            continue;
        }
        candidates.push(entry);
        bytes += entry.size;
    }
    return { candidates, unavailableIds, deferredIds };
}

export function estimateBase64Bytes(value: unknown): number | null {
    if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
    let padding = 0;
    if (value.endsWith('==')) padding = 2;
    else if (value.endsWith('=')) padding = 1;
    return Math.max(0, (value.length * 3) / 4 - padding);
}

export function isAttachmentAllowedByPolicy(
    attachment: { mimeType: string; size: number },
    policy: { maxBytes: number; mediaTypes: string[] },
): boolean {
    const sizeAllowed = attachment.size <= 0 || attachment.size <= policy.maxBytes;
    const mediaAllowed = policy.mediaTypes.some((allowed) => (
        allowed === attachment.mimeType
        || (allowed.endsWith('/*') && attachment.mimeType.startsWith(allowed.slice(0, -1)))
    ));
    return sizeAllowed && mediaAllowed;
}
