/**
 * The prompt-attachments pill listing: metadata-only view of the session
 * pane's dump directory. Product code (the extracted Attachments add-on's
 * rpc.mjs, ported with its flow tests). Bytes never go through this listing;
 * opening an item resolves through the artifact transports by content id.
 *
 * Trust boundary: the caller supplies only the sessionId; the dispatcher
 * resolves the pane from the session record, so a client can never choose a
 * dump directory. The pane-id guard below still rejects hostile ids
 * ('.', '..', separators) wherever a pane id is taken at face value.
 * MUXR_HOME is respected through the artifact watcher's root, not here.
 */
import type { SessionArtifactMetadata } from '@trymuxr/contract';

export interface PromptAttachmentItem {
    id: string;
    title: string;
    subtitle: string;
    icon: string;
    at: number;
    action: {
        type: 'attachment';
        id: string;
        name: string;
        mimeType: string;
        size: number;
    };
}

/** Same pane-id rule as `muxr share`: only real pane ids resolve inside the dump root. */
export function isSafePaneId(paneId: string): boolean {
    return paneId !== '' && paneId !== '.' && !paneId.includes('..') && !paneId.includes('/') && !paneId.includes('\\');
}

const MIME: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    pdf: 'application/pdf',
    apk: 'application/vnd.android.package-archive',
    json: 'text/plain',
    txt: 'text/plain',
    md: 'text/plain',
};

function iconFor(ext: string): string {
    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image-outline';
    if (['mp4', 'mov', 'webm'].includes(ext)) return 'videocam-outline';
    if (ext === 'apk') return 'logo-android';
    if (['json', 'txt', 'md'].includes(ext)) return 'document-text-outline';
    return 'document-attach-outline';
}

function formatSize(size: number): string {
    return size >= 1048576 ? `${Math.round(size / 1048576)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
}

/**
 * Shape scanned dump entries into pill items. Relay-backed small-file reads
 * require the content id; larger files never enter the app and local
 * downloads resolve by name, so big entries carry their name instead of
 * re-hashing on every open.
 */
export function presentAttachmentItems(
    entries: readonly SessionArtifactMetadata[],
    maxHostedReadBytes = 2 * 1024 * 1024,
): { items: PromptAttachmentItem[]; total: number } {
    const items: PromptAttachmentItem[] = [];
    for (const { id, name, mimeType, size, at } of entries.slice(0, 50)) {
        const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
        items.push({
            id: name,
            title: name,
            subtitle: formatSize(size),
            icon: iconFor(ext),
            at,
            action: {
                type: 'attachment',
                id: size <= maxHostedReadBytes ? id : name,
                name,
                mimeType: mimeType || MIME[ext] || 'application/octet-stream',
                size,
            },
        });
    }
    return { items, total: entries.length };
}
