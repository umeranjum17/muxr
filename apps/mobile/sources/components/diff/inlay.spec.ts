import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FOLD_CONTEXT, MAX_FOLD_DISTANCE, foldRuns, inlay, parseHunks } from '@/components/diff/inlay';
import { surfaceModel } from '@/components/document/surfaceModel';

/**
 * The reading surface shows a patch laid back into its file as one document.
 * If `inlay` mis-aligns, the reader is shown a lie: added lines attached to the
 * wrong place, or context that is not in the file. This drives a real patch and
 * the real file it came from through the whole path the viewer uses.
 *
 * The pair is committed rather than read out of git history. It used to come
 * from `git show 5b58f5c9`, which fails on a shallow CI checkout that does not
 * contain that commit. These are the genuine artefacts of it - 13 hunks against
 * the 392-line file they applied to - so the flow is unchanged; only where the
 * bytes come from is.
 */

const fixtures = path.join(__dirname, '__fixtures__');
const patchText = readFileSync(path.join(fixtures, 'pierre-diff-view.patch'), 'utf8');
const afterText = readFileSync(path.join(fixtures, 'pierre-diff-view.after.tsx.txt'), 'utf8');

function committedPatch(): string {
    return patchText;
}

function fileAt(): string {
    return afterText;
}

describe('inlay', () => {
    it('lays a real patch back into the file it produced, and folds what it did not touch', () => {
        const patch = committedPatch();
        const after = fileAt();
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
        const after = fileAt();
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
        const built = surfaceModel({ code: afterText, showChanges: false });
        expect(built).not.toBeNull();
        expect(built!.hunkRows).toEqual([]);
        expect(built!.separators).toEqual([]);
        expect(built!.rows.every((row) => row.prefix === ' ' && row.hunk === -1)).toBe(true);
    });
});
