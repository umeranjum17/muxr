const MAX_BLOB_BYTES = 32 * 1024 * 1024;
type BlobEntry = { blob: Blob; uri: string; size: number };
const blobMap = new Map<string, BlobEntry>();
let blobTotalBytes = 0;

const MIME_BY_EXT: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif',
};

/** Decode base64 without retaining a data URI; callers account conservatively. */
const B64_TABLE = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64_TABLE['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;

function base64ToBytes(base64: string): Uint8Array {
    const clean = base64.replace(/=+$/, '');
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let acc = 0; let bits = 0; let at = 0;
    for (let i = 0; i < clean.length; i++) {
        acc = ((acc << 6) | B64_TABLE[clean.charCodeAt(i)]) & 0x3fff;
        bits += 6;
        if (bits >= 8) { bits -= 8; out[at++] = (acc >>> bits) & 0xff; }
    }
    return out;
}

export function estimateStoredBlobBytes(base64: string): number {
    return Math.floor(base64.replace(/=+$/, '').length * 3 / 4) + base64.length;
}

function evictOldest(): string[] {
    const evicted: string[] = [];
    while (blobTotalBytes > MAX_BLOB_BYTES) {
        const id = blobMap.keys().next().value as string | undefined;
        if (id === undefined) break;
        const entry = blobMap.get(id)!;
        URL.revokeObjectURL(entry.uri);
        blobMap.delete(id);
        blobTotalBytes -= entry.size;
        evicted.push(id);
    }
    return evicted;
}

export interface SaveBlobResult {
    uri?: string;
    evictedIds: string[];
}

/** Store Blob/object URLs only; data/blob URLs never enter persistence. */
export async function saveBlob(id: string, base64: string, ext: string): Promise<SaveBlobResult> {
    const bytes = base64ToBytes(base64);
    const size = estimateStoredBlobBytes(base64); // conservative decoded + encoded accounting
    const old = blobMap.get(id);
    if (old !== undefined) { URL.revokeObjectURL(old.uri); blobMap.delete(id); blobTotalBytes -= old.size; }
    if (size > MAX_BLOB_BYTES) return { evictedIds: [id] };
    const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream' });
    blobMap.set(id, { blob, uri: URL.createObjectURL(blob), size });
    blobTotalBytes += size;
    const evictedIds = evictOldest();
    return { uri: blobMap.get(id)?.uri, evictedIds };
}

export async function blobUri(id: string): Promise<string | null> {
    return blobMap.get(id)?.uri ?? null;
}

export async function readBlobText(id: string): Promise<string | null> {
    const entry = blobMap.get(id);
    return entry === undefined ? null : entry.blob.text();
}

export async function blobObjectUrl(id: string): Promise<string | null> {
    return blobMap.get(id)?.uri ?? null;
}

export async function readBlobBytes(id: string): Promise<Uint8Array | null> {
    const entry = blobMap.get(id);
    return entry === undefined ? null : new Uint8Array(await entry.blob.arrayBuffer());
}

export async function pruneBlobs(keepIds: Set<string>): Promise<void> {
    for (const [id, entry] of [...blobMap.entries()]) {
        if (!keepIds.has(id)) {
            URL.revokeObjectURL(entry.uri);
            blobMap.delete(id);
            blobTotalBytes -= entry.size;
        }
    }
}
