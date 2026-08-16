#!/usr/bin/env node
/** Metadata-only listing of this pane's dump dir. Bytes never go on this RPC. */
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8') || 'null') ?? {};
const paneId = typeof input.paneId === 'string' ? input.paneId : '';
if (paneId === '' || paneId.includes('..') || paneId.includes('/') || paneId.includes('\\')) {
    process.stdout.write(JSON.stringify({ items: [] }));
    process.exit(0);
}

const MAX_HOSTED_READ_BYTES = 2 * 1024 * 1024;

const MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', pdf: 'application/pdf',
    apk: 'application/vnd.android.package-archive', json: 'text/plain', txt: 'text/plain', md: 'text/plain',
};

function iconFor(ext) {
    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image-outline';
    if (['mp4', 'mov', 'webm'].includes(ext)) return 'videocam-outline';
    if (ext === 'apk') return 'logo-android';
    if (['json', 'txt', 'md'].includes(ext)) return 'document-text-outline';
    return 'document-attach-outline';
}

const root = join(process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr'), 'attachments', 'pane', paneId);
let names = [];
try {
    names = readdirSync(root).filter((name) => !name.startsWith('.'));
} catch {
    process.stdout.write(JSON.stringify({ items: [] }));
    process.exit(0);
}

function hashFile(path) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        createReadStream(path)
            .on('data', (chunk) => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')))
            .on('error', reject);
    });
}

const files = [];
for (const name of names) {
    try {
        const path = join(root, name);
        const info = statSync(path);
        if (info.isFile()) files.push({ name, path, size: info.size, at: Math.floor(info.mtimeMs) });
    } catch { /* vanished mid-scan */ }
}
files.sort((a, b) => b.at - a.at);
const items = [];
for (const { name, path, size, at } of files.slice(0, 50)) {
    try {
        const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
        items.push({
            id: name,
            title: name,
            subtitle: size >= 1048576 ? `${Math.round(size / 1048576)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`,
            icon: iconFor(ext),
            at,
            action: {
                type: 'attachment',
                // Hosted small-file reads require the content id. Larger files
                // never enter the app and local downloads resolve by name, so
                // do not re-hash every APK/video whenever the sheet opens.
                id: size <= MAX_HOSTED_READ_BYTES ? await hashFile(path) : name,
                name,
                mimeType: MIME[ext] ?? 'application/octet-stream',
                size,
            },
        });
    } catch { /* vanished mid-scan */ }
}
process.stdout.write(JSON.stringify({ items, total: files.length }));
