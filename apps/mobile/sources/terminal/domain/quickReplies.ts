/**
 * Personal quick replies: short prompts the person writes on this device,
 * kept in local settings, insert-only. They are convenience text, not a
 * prompt marketplace and not a cross-device store, so the bounds are small
 * and the validator rejects rather than truncates.
 */

export const QUICK_REPLY_LIMIT = 32;
export const QUICK_REPLY_LABEL_LIMIT = 80;
export const QUICK_REPLY_TEXT_LIMIT = 8 * 1024;

export interface PersonalQuickReply {
    /** Stable on this device; replies are reordered and edited by it. */
    id: string;
    label: string;
    text: string;
}

/** Human-readable reasons a reply would be rejected; empty means it may save. */
export function personalReplyErrors(label: string, text: string): string[] {
    const errors: string[] = [];
    if (label.trim() === '') errors.push('Give the reply a name.');
    else if (label.length > QUICK_REPLY_LABEL_LIMIT) errors.push(`Keep the name to ${QUICK_REPLY_LABEL_LIMIT} characters.`);
    if (text.trim() === '') errors.push('Give the reply some text.');
    else if (text.length > QUICK_REPLY_TEXT_LIMIT) errors.push(`Keep the text to ${QUICK_REPLY_TEXT_LIMIT.toLocaleString()} characters.`);
    return errors;
}
