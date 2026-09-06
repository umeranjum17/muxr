import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/catalog/sync', () => ({
    registerPluginInvalidationHandler: () => {},
}));
import { patchFiles, uniqueDiffLabels } from '@/components/diff/patchFiles';
import { nearestContentMount } from '@/plugins/domain/screenModel';
import {
    currentFileNavigation,
    gitDirectoryProbeCommand,
    gitDirectorySearchPaths,
    openFileViewer,
    recordFileNavigation,
} from './fileNavigationList';

const changesScript = join(dirname(fileURLToPath(import.meta.url)), '../../../../../plugins/code/changes.mjs');

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
diff --git "a/é file.ts" "b/é file.ts"
index aaaaaaa..bbbbbbb 100644
--- "a/é file.ts"
+++ "b/é file.ts"
@@ -1 +1 @@
-plain
+quoted
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
            { label: 'é file.ts', status: 'modified', added: 1, removed: 1 },
        ]);
        expect(uniqueDiffLabels(files.map((file) => file.label))).toEqual([
            'old.ts',
            'a/shared/index.ts',
            'b/shared/index.ts',
            'notes.md',
            'é.ts',
            'é file.ts',
        ]);

        const repo = mkdtempSync(join(tmpdir(), 'muxr-changes-copy-'));
        try {
            const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 5000 });
            git(['init', '-q', '-b', 'main']);
            writeFileSync(join(repo, 'kept.ts'), 'export const kept = true;\n');
            git(['add', '.']);
            git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Baseline']);
            writeFileSync(join(repo, 'copied.ts'), 'export const kept = true;\n');
            git(['add', 'copied.ts']);
            const items = JSON.parse(execFileSync(process.execPath, [changesScript], {
                encoding: 'utf8', input: JSON.stringify({ cwd: repo, sessionId: 'session-1' }), timeout: 10000,
            })).items as Array<{ id: string; title: string; action: unknown }>;
            expect(items.filter((item) => item.id !== 'review-context').map(({ title, action }) => ({ title, action }))).toEqual([
                { title: 'copied.ts', action: { type: 'kernel.navigate', target: 'file', path: join(repo, 'copied.ts') } },
            ]);
        } finally {
            rmSync(repo, { recursive: true, force: true });
        }

        const reviewKey = recordFileNavigation({
            sessionId: 'session-1',
            sourceKey: 'you.review\0files',
            selectedPath: '/repo/a.ts',
            items: [
                { id: 'row-a', title: 'first', metadata: [], action: { type: 'kernel.navigate', target: 'file', path: '/repo/a.ts' } },
                { id: 'row-a-again', title: 'dup', group: 'Addressed', metadata: [{ value: '+VIP' }], action: { type: 'kernel.navigate', target: 'file', path: '/repo/a.ts' } },
                { id: 'row-bin', title: 'photo', metadata: [{ value: 'binary', tone: 'secondary' }], action: { type: 'kernel.navigate', target: 'file', path: '/repo/photo.png' } },
                { id: 'row-fake-bin', title: 'notes', metadata: [{ value: 'binary' }], action: { type: 'kernel.navigate', target: 'file', path: '/repo/notes.md' } },
                { id: 'row-b', title: 'second', metadata: [], action: { type: 'kernel.navigate', target: 'file', path: '/repo/b.ts' } },
            ],
        });
        const current = currentFileNavigation('session-1', '/repo/a.ts', reviewKey);
        expect(current?.entries.map((entry) => entry.path)).toEqual(['/repo/a.ts', '/repo/photo.png', '/repo/notes.md', '/repo/b.ts']);
        expect(current?.index).toBe(0);
        expect(current!.entries[current!.index + 1]?.path).toBe('/repo/photo.png');
        expect(currentFileNavigation('session-1', '/repo/photo.png', reviewKey)!.entries[1]!.metadata).toEqual([{ value: 'binary', tone: 'secondary' }]);
        expect(currentFileNavigation('session-1', '/repo/notes.md', reviewKey)!.entries[2]!.metadata).toEqual([{ value: 'binary' }]);
        expect(currentFileNavigation('session-1', '/repo/b.ts', reviewKey)?.index).toBe(3);
        expect(currentFileNavigation('session-1', '/repo/a.ts')).toBeNull();

        const otherKey = recordFileNavigation({
            sessionId: 'session-1',
            sourceKey: 'other.plugin\0files',
            selectedPath: '/other/x.ts',
            items: [
                { id: 'other', title: 'other', metadata: [], action: { type: 'kernel.navigate', target: 'file', path: '/other/x.ts' } },
            ],
        });
        expect(otherKey).not.toBe(reviewKey);
        expect(currentFileNavigation('session-1', '/repo/a.ts', reviewKey)?.entries).toHaveLength(4);
        expect(openFileViewer({ sessionId: 'session-1', path: '/repo/b.ts', navigation: { key: reviewKey! } }))
            .toBe(`/session/session-1/file?path=${encodeURIComponent('/repo/b.ts')}&nav=${encodeURIComponent(reviewKey!)}`);

        const third = currentFileNavigation('session-1', '/repo/notes.md', reviewKey);
        expect(third?.index).toBe(2);
        expect(third?.key).toBe(reviewKey);
        const afterNext = third!.entries[third!.index + 1]!;
        expect(openFileViewer({ sessionId: 'session-1', path: afterNext.path, navigation: { key: reviewKey! } }))
            .toBe(`/session/session-1/file?path=${encodeURIComponent('/repo/b.ts')}&nav=${encodeURIComponent(reviewKey!)}`);
        expect(currentFileNavigation('session-1', afterNext.path, reviewKey)).toEqual(expect.objectContaining({ index: 3, key: reviewKey }));

        const mounts = [
            { contentContributionId: 'foo.files', label: 'Files' },
            { contentContributionId: 'foo.settings', label: 'Settings' },
        ];
        expect(nearestContentMount(mounts, 'foo.settings.detail')?.label).toBe('Settings');
        expect(nearestContentMount(mounts, 'foo.files')?.label).toBe('Files');
        expect(nearestContentMount(mounts, 'foo.other.x')).toBeUndefined();
    });
});

function probe(filePath: string, sessionPath: string): string {
    return execFileSync('/bin/bash', ['-lc', gitDirectoryProbeCommand(filePath, sessionPath)], { encoding: 'utf8' });
}
