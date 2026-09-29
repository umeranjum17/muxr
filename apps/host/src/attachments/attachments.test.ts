import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { isSafePaneId, presentAttachmentItems } from './attachments.js';

/** Watcher-shaped scan entries: newest-first metadata with sha256 content ids. */
function entry(name: string, size: number, at: number, id?: string) {
    return {
        id: id ?? createHash('sha256').update(name).digest('hex'),
        name,
        mimeType: 'application/octet-stream',
        size,
        at,
    };
}

describe('prompt attachments listing', () => {
    it('shapes scan entries into pill items with icons and sizes', () => {
        const { items, total } = presentAttachmentItems([
            entry('screen.png', 8, 2_000_000_000_000),
            entry('notes.md', 2048, 1_500_000_000_000),
            entry('build.apk', 3 * 1024 * 1024, 1_000_000_000_000),
        ]);
        expect(total).toBe(3);
        expect(items.map((item) => item.title)).toEqual(['screen.png', 'notes.md', 'build.apk']);
        expect(items[0]?.icon).toBe('image-outline');
        expect(items[0]?.subtitle).toBe('1 KB');
        expect(items[1]?.icon).toBe('document-text-outline');
        expect(items[2]?.icon).toBe('logo-android');
        expect(items[2]?.subtitle).toBe('3 MB');
    });

    it('opens small files by content id and large files by name', () => {
        const sha = createHash('sha256').update('screen').digest('hex');
        const { items } = presentAttachmentItems([entry('screen.png', 8, 1, sha), entry('build.apk', 3 * 1024 * 1024, 0)]);
        expect(items[0]?.action).toMatchObject({ type: 'attachment', id: sha, name: 'screen.png' });
        // Larger files never enter the app; local downloads resolve by name.
        expect(items[1]?.action).toMatchObject({ type: 'attachment', id: 'build.apk', name: 'build.apk' });
    });

    it('rejects hostile pane ids', () => {
        expect(isSafePaneId('lab:p1')).toBe(true);
        for (const hostile of ['', '.', '..', '../x', 'a/b', 'a\\b', 'a..b/../c']) {
            expect(isSafePaneId(hostile)).toBe(false);
        }
    });
});
