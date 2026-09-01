import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { patchFiles, uniqueDiffLabels } from '@/components/diff/patchFiles';
import { nearestContentMount } from '@/plugins/domain/screenModel';
import {
    currentFileNavigation,
    fileNavControlLabel,
    gitDirectoryProbeCommand,
    gitDirectorySearchPaths,
    recordFileNavigation,
} from './fileNavigationList';

const commit = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 1111111..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const gone = 1;
-export const also = 2;
diff --git a/a/shared/index.ts b/a/shared/index.ts
index 2222222..3333333 100644
--- a/a/shared/index.ts
+++ b/a/shared/index.ts
@@ -1,3 +1,4 @@
 keep
+++added plusplus
----removed minusminus
+ok
diff --git a/b/shared/index.ts b/b/shared/index.ts
index 4444444..5555555 100644
--- a/b/shared/index.ts
+++ b/b/shared/index.ts
@@ -1 +1,2 @@
-old
+new
+readme
diff --git a/notes.md b/notes.md
index 6666666..7777777 100644
--- a/notes.md
+++ b/notes.md
@@ -1 +1 @@
-before
+after
diff --git "a/\\303\\251.ts" "b/\\303\\251.ts"
index 8888888..9999999 100644
--- "a/\\303\\251.ts"
+++ "b/\\303\\251.ts"
@@ -1 +1 @@
-old
+new
`;

describe('file and diff navigation', () => {
    it('opens a third-party file, reads a mixed commit, and titles the nested screen', () => {
        const root = mkdtempSync(join(tmpdir(), 'muxr-file-nav-'));
        try {
            const otherFile = join(root, 'other', 'repo', 'src', 'app.ts');
            const session = join(root, 'main');
            mkdirSync(join(root, 'other', 'repo', 'src'), { recursive: true });
            mkdirSync(session, { recursive: true });
            writeFileSync(otherFile, 'export {}\n');

            expect(gitDirectorySearchPaths(otherFile, session)[0]).toBe(join(root, 'other', 'repo', 'src'));
            expect(gitDirectorySearchPaths(otherFile, session).at(-1)).toBe(session);
            expect(probe(otherFile, session)).toBe(join(root, 'other', 'repo', 'src'));
            expect(probe(join(root, 'other', 'repo', 'gone', 'file.ts'), session)).toBe(join(root, 'other', 'repo'));
            expect(gitDirectorySearchPaths('orphan.ts', session)).toEqual([session]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }

        const files = patchFiles(commit);
        expect(files.map((file) => ({ label: file.label, status: file.status, added: file.added, removed: file.removed }))).toEqual([
            { label: 'src/old.ts', status: 'deleted', added: 0, removed: 2 },
            { label: 'a/shared/index.ts', status: 'modified', added: 2, removed: 1 },
            { label: 'b/shared/index.ts', status: 'modified', added: 2, removed: 1 },
            { label: 'notes.md', status: 'modified', added: 1, removed: 1 },
            { label: 'é.ts', status: 'modified', added: 1, removed: 1 },
        ]);
        expect(uniqueDiffLabels(files.map((file) => file.label))).toEqual([
            'old.ts',
            'a/shared/index.ts',
            'b/shared/index.ts',
            'notes.md',
            'é.ts',
        ]);

        recordFileNavigation('session-1', [
            { id: 'row-a', title: 'first', metadata: [], action: { type: 'kernel.navigate', target: 'file', path: '/repo/a.ts' } },
            { id: 'row-a-again', title: 'dup', group: 'Addressed', metadata: [{ value: '+VIP' }], action: { type: 'kernel.navigate', target: 'file', path: '/repo/a.ts' } },
            { id: 'row-b', title: 'second', metadata: [], action: { type: 'kernel.navigate', target: 'file', path: '/repo/b.ts' } },
        ], '/repo/a.ts');
        const current = currentFileNavigation('session-1', '/repo/a.ts');
        expect(current?.entries.map((entry) => entry.path)).toEqual(['/repo/a.ts', '/repo/b.ts']);
        expect(current?.index).toBe(0);
        expect(current!.entries[current!.index + 1]?.path).toBe('/repo/b.ts');
        expect(currentFileNavigation('session-1', '/repo/b.ts')?.index).toBe(1);

        const mounts = [
            { contentContributionId: 'foo.files', label: 'Files' },
            { contentContributionId: 'foo.settings', label: 'Settings' },
        ];
        expect(nearestContentMount(mounts, 'foo.settings.detail')?.label).toBe('Settings');
        expect(nearestContentMount(mounts, 'foo.files')?.label).toBe('Files');
        expect(nearestContentMount(mounts, 'foo.other.x')).toBeUndefined();

        expect(fileNavControlLabel('next', 'b.ts', 0, 3)).toBe('Next changed file, b.ts, 2 of 3');
        expect(fileNavControlLabel('previous', 'a.ts', 1, 3)).toBe('Previous changed file, a.ts, 1 of 3');
        expect(fileNavControlLabel('previous', undefined, 0, 3)).toBe('Previous changed file');
    });
});

function probe(filePath: string, sessionPath: string): string {
    return execFileSync('/bin/bash', ['-lc', gitDirectoryProbeCommand(filePath, sessionPath)], { encoding: 'utf8' });
}
