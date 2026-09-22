import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARTIFACT_RETENTION, ARTIFACT_RETENTION_REPORT_FILE, runArtifactRetention } from './artifactRetention.js';
import { MAX_ARTIFACTS } from './artifactWatcher.js';

const DAY = 86_400_000;
const MINUTE = 60_000;

const homes: string[] = [];
afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home(): { root: string; reportPath: string } {
    const dir = mkdtempSync(join(tmpdir(), 'muxr-retention-'));
    homes.push(dir);
    return { root: join(dir, 'attachments', 'pane'), reportPath: join(dir, ARTIFACT_RETENTION_REPORT_FILE) };
}

/** One 16-byte file shared at `at`, with the mtime the sweep orders by. */
function share(root: string, paneId: string, name: string, at: number): void {
    const dir = join(root, paneId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, 'x'.repeat(16));
    utimesSync(path, new Date(at), new Date(at));
}

describe('artifact retention sweep', () => {
    it('bounds a pane without touching what it already had, what is still fresh, or a live write', async () => {
        const { root, reportPath } = home();
        const epoch = Date.now();
        // Minutes apart and strictly after the epoch: a coarse filesystem clock
        // would tie several mtimes together, and a file shared at the exact
        // instant retention was installed is pre-existing history, not a candidate.
        const shared = (index: number) => epoch + (index + 1) * MINUTE;

        // The accumulation the policy is not allowed to touch: shared before
        // retention existed here.
        share(root, 'w1:p1', 'legacy-report.pdf', epoch - 20 * DAY);
        // 55 files shared right after retention landed.
        for (let index = 0; index < 55; index += 1) share(root, 'w1:p1', `shot-${String(index).padStart(2, '0')}.png`, shared(index));
        // A live session dropping a file, and `muxr share` mid-copy.
        share(root, 'w1:p2', 'live-recording.mp4', epoch + 12 * DAY - MINUTE);
        share(root, 'w1:p2', '.share-6f2a.tmp', epoch + 12 * DAY - MINUTE);

        // The first sweep has no report to read, so it only installs the epoch.
        await runArtifactRetention({ rootDir: root, reportPath, now: epoch });
        expect(readdirSync(join(root, 'w1:p1'))).toHaveLength(56);

        const { run, report } = await runArtifactRetention({ rootDir: root, reportPath, now: epoch + 12 * DAY });
        const gone = run.removed.map((record) => `${record.paneId}/${record.name}`).sort();

        // Beyond the newest 50 and older than a week: exactly the five oldest.
        expect(gone).toEqual(['w1:p1/shot-00.png', 'w1:p1/shot-01.png', 'w1:p1/shot-02.png', 'w1:p1/shot-03.png', 'w1:p1/shot-04.png']);
        expect(run.removedBytes).toBe(5 * 16);
        // The newest 50 the timeline can show, the pre-existing history, the
        // file a live session just dropped and its in-flight temp all survive.
        expect(readdirSync(join(root, 'w1:p1')).sort()).toEqual([
            'legacy-report.pdf',
            ...Array.from({ length: 50 }, (_, index) => `shot-${String(index + 5).padStart(2, '0')}.png`),
        ]);
        expect(readdirSync(join(root, 'w1:p2')).sort()).toEqual(['.share-6f2a.tmp', 'live-recording.mp4']);
        // `kept` counts real artifacts only; the in-flight temp is not one.
        expect(run.kept).toBe(56 + 1 - run.removedCount);

        // The removals are recorded rather than silent, and the report names the policy.
        expect(report.epochMs).toBe(epoch);
        expect(report.lastSweep?.removed).toEqual(run.removed);
        const onDisk = JSON.parse(readFileSync(reportPath, 'utf8'));
        expect(onDisk.policy).toEqual(ARTIFACT_RETENTION);
        expect(onDisk.lastSweep.removedCount).toBe(5);
    });

    it('takes the count bound first, then empties an abandoned pane by age alone', async () => {
        const { root, reportPath } = home();
        const epoch = Date.now();
        for (let index = 0; index < 55; index += 1) share(root, 'w1:p1', `shot-${index}.png`, epoch + (index + 1) * MINUTE);
        await runArtifactRetention({ rootDir: root, reportPath, now: epoch });

        // A week on: the count bound takes the five past the newest 50.
        const counted = await runArtifactRetention({ rootDir: root, reportPath, now: epoch + 8 * DAY });
        expect(counted.run.removedCount).toBe(5);
        expect(readdirSync(join(root, 'w1:p1'))).toHaveLength(50);

        // A month on: no post-epoch file survives the age bound, so an abandoned
        // pane empties instead of holding 50 files for ever.
        const aged = await runArtifactRetention({ rootDir: root, reportPath, now: epoch + 40 * DAY });
        expect(aged.run.removedCount).toBe(50);
        expect(readdirSync(join(root, 'w1:p1'))).toEqual([]);
    });

    it('never shows a pane fewer files than the timeline lists', () => {
        // The count bound is only safe while it is at least what the watcher
        // publishes: below that the sweep would delete rows the phone can see.
        expect(ARTIFACT_RETENTION.keepNewest).toBeGreaterThanOrEqual(MAX_ARTIFACTS);
    });
});
