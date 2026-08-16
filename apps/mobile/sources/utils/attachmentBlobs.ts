/**
 * Attachment blobs on disk — native implementation.
 *
 * Blobs live as files under documentDirectory/attachments/<id>.<ext>, keyed by
 * the content-hash id, so metadata-only re-emits never rewrite them.
 */
import {
    deleteAsync,
    documentDirectory,
    getInfoAsync,
    makeDirectoryAsync,
    readAsStringAsync,
    readDirectoryAsync,
    writeAsStringAsync,
    EncodingType,
} from 'expo-file-system/legacy';

function blobsDir(): string {
    if (!documentDirectory) throw new Error('attachmentBlobs: documentDirectory unavailable');
    return `${documentDirectory}attachments/`;
}

function uriFor(id: string, ext: string): string {
    return `${blobsDir()}${id}.${ext}`;
}

/** Write the blob once; a file already present for this id is left alone. */
export interface SaveBlobResult {
    uri?: string;
    evictedIds: string[];
}

export async function saveBlob(id: string, base64: string, ext: string): Promise<SaveBlobResult> {
    await makeDirectoryAsync(blobsDir(), { intermediates: true }).catch(() => undefined);
    const uri = uriFor(id, ext);
    const info = await getInfoAsync(uri);
    if (!info.exists) {
        await writeAsStringAsync(uri, base64, { encoding: EncodingType.Base64 });
    }
    return { uri, evictedIds: [] };
}

export async function blobUri(id: string, ext: string): Promise<string | null> {
    const info = await getInfoAsync(uriFor(id, ext));
    return info.exists ? info.uri : null;
}

/** Text attachments (md, eml, code...) read back as utf8 for the preview modal. */
export async function readBlobText(id: string, ext: string): Promise<string | null> {
    const info = await getInfoAsync(uriFor(id, ext));
    if (!info.exists) return null;
    return readAsStringAsync(info.uri);
}

/** Raw bytes for pdf.js-style viewers. */
export async function readBlobBytes(id: string, ext: string = ''): Promise<Uint8Array | null> {
    const info = await getInfoAsync(uriFor(id, ext));
    if (!info.exists) return null;
    const base64 = await readAsStringAsync(info.uri, { encoding: EncodingType.Base64 });
    const TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const clean = base64.replace(/=+$/, '');
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let acc = 0;
    let bits = 0;
    let at = 0;
    for (const char of clean) {
        acc = (acc << 6) | TABLE.indexOf(char);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[at] = (acc >> bits) & 0xff;
            at += 1;
        }
    }
    return out;
}

/** On native the blob's file URI already IS a URL every viewer accepts. */
export async function blobObjectUrl(id: string, ext: string = ''): Promise<string | null> {
    return blobUri(id, ext);
}

/** Best-effort: delete every blob whose id is in no session's list anymore. */
export async function pruneBlobs(keepIds: Set<string>): Promise<void> {
    try {
        const entries = await readDirectoryAsync(blobsDir());
        for (const entry of entries) {
            const id = entry.replace(/\.[^.]*$/, '');
            if (!keepIds.has(id)) {
                await deleteAsync(`${blobsDir()}${entry}`, { idempotent: true }).catch(() => undefined);
            }
        }
    } catch {
        // No attachments dir (or unreadable) — nothing to prune.
    }
}
