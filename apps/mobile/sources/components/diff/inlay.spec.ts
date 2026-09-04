import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { FOLD_CONTEXT, MAX_FOLD_DISTANCE, foldRuns, inlay, parseHunks } from '@/components/diff/inlay';
import { surfaceModel } from '@/components/document/surfaceModel';

/**
 * The reading surface shows a patch laid back into its file as one document.
 * If `inlay` mis-aligns, the reader is shown a lie: added lines attached to the
 * wrong place, or context that is not in the file. This drives a real patch and
 * the real file it came from through the whole path the viewer uses.
 */

const repo = path.resolve(__dirname, '../../../../..');
const target = 'apps/mobile/sources/components/diff/PierreDiffView.tsx';

function committedPatch(): string {
    return execFileSync('git', ['-C', repo, '-c', 'diff.mnemonicPrefix=false', 'show', '5b58f5c9', '--no-ext-diff', '--format=', '--', target], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
    });
}

function fileAt(revision: string): string {
    return execFileSync('git', ['-C', repo, 'show', `${revision}:${target}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

describe('inlay', () => {
    it('lays a real patch back into the file it produced, and folds what it did not touch', () => {
        const patch = committedPatch();
        const after = fileAt('5b58f5c9');
        const hunks = parseHunks(patch);
        expect(hunks.length).toBeGreaterThan(1);

        const laid = inlay(after, patch);
        expect(laid).not.toBeNull();
        const rows = laid!.rows;

        // Every added and context row must be the file's own line, in order.
        const rebuilt = rows.filter((row) => row.prefix !== '-').map((row) => row.text).join('\n');
        expect(rebuilt).toBe(after);
        // Removed lines are extra rows on top of the file, never replacements.
        expect(rows.length).toBe(after.split('\n').length + rows.filter((row) => row.prefix === '-').length);
        expect(laid!.hunkRows.length).toBe(hunks.length);

        // Unchanged runs collapse, and a run is only folded when it is longer
        // than the gap difftastic would have merged across.
        const folds = foldRuns(rows);
        expect(folds.length).toBeGreaterThan(0);
        expect(folds.length).toBeLessThanOrEqual(hunks.length + 1);
        for (const run of folds) expect(run.end - run.start).toBeGreaterThan(MAX_FOLD_DISTANCE);
        // Nothing within the context window of a change may be hidden.
        const changed = rows.flatMap((row, index) => row.hunk >= 0 ? [index] : []);
        for (const run of folds) {
            for (const index of changed) {
                expect(index < run.start - FOLD_CONTEXT || index >= run.end + FOLD_CONTEXT).toBe(true);
            }
        }
    });

    it('refuses a patch that does not describe the content, rather than guessing', () => {
        const patch = committedPatch();
        const after = fileAt('5b58f5c9');
        const lines = after.split('\n');
        // One altered context line is enough to make the alignment a fiction.
        const firstContext = parseHunks(patch)[0]!;
        const victim = firstContext.newStart + 1;
        lines[victim] = `${lines[victim] ?? ''} // drifted`;
        expect(inlay(lines.join('\n'), patch)).toBeNull();
    });

    it('marks the gaps a patch skipped when there is no file content behind it', () => {
        const patch = committedPatch();
        const built = surfaceModel({ diff: patch, showChanges: true });
        expect(built).not.toBeNull();
        expect(built!.inlaid).toBe(false);
        // Without separators two hunks a line apart read as one block.
        expect(built!.separators.length).toBeGreaterThan(0);
        expect(built!.separators.length).toBeLessThanOrEqual(built!.hunkRows.length);
        for (const gap of built!.separators) expect(gap.lines).toBeGreaterThan(0);
    });

    it('reads a plain file as the same row shape, with nothing to fold', () => {
        const built = surfaceModel({ code: readFileSync(path.join(repo, target), 'utf8'), showChanges: false });
        expect(built).not.toBeNull();
        expect(built!.hunkRows).toEqual([]);
        expect(built!.separators).toEqual([]);
        expect(built!.rows.every((row) => row.prefix === ' ' && row.hunk === -1)).toBe(true);
    });
});
