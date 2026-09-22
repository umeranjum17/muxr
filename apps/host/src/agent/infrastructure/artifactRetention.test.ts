import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARTIFACT_RETENTION, ARTIFACT_RETENTION_REPORT_FILE, planArtifactSweep, runArtifactRetention, type ArtifactFile } from './artifactRetention.js';
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

/**
 * One 16-byte file carrying `at` as its modification time. The change time is
 * whatever the kernel stamps now, which is how the sweep reads scope and age: a
 * file written here just entered the pane, however old its mtime is.
 */
function share(root: string, paneId: string, name: string, at: number): void {
    const dir = join(root, paneId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, 'x'.repeat(16));
    utimesSync(path, new Date(at), new Date(at));
}

describe('artifact retention policy', () => {
    it('reads scope and age from the change time, and order from the modification time', () => {
        const epoch = Date.now() - 90 * DAY;
        const now = Date.now();
        const files: ArtifactFile[] = [
            // The accumulation the policy leaves alone: it entered the pane
            // before retention existed here and never counts against a bound.
            { name: 'legacy.rec', size: 16, at: epoch - 20 * DAY, changedAt: epoch - 20 * DAY },
            // Moved in today: an old modification time, a fresh change time.
            { name: 'moved.mp4', size: 16, at: now - 45 * DAY, changedAt: now - MINUTE },
            // Shared after retention landed, and genuinely old on both clocks.
            { name: 'old.png', size: 16, at: epoch + DAY, changedAt: epoch + DAY },
            // Shared after retention landed, and still fresh on both clocks.
            { name: 'new.png', size: 16, at: now - MINUTE, changedAt: now - MINUTE },
        ];

        const plan = planArtifactSweep(files, { epochMs: epoch, now });
        expect(plan.remove.map((file) => file.name)).toEqual(['old.png']);
        expect(plan.kept).toBe(3);

        // The count bound is only safe while it is at least what the watcher
        // publishes: below that the sweep would delete rows the phone can see.
        expect(ARTIFACT_RETENTION.keepNewest).toBeGreaterThanOrEqual(MAX_ARTIFACTS);
    });
});

describe('artifact retention sweep', () => {
    it('keeps a file that moved in with an old modification time', async () => {
        const { root, reportPath } = home();
        // Retention has been installed for months, and today a 45-day-old
        // recording is moved into the pane.
        const installed = Date.now() - 90 * DAY;
        share(root, 'w1:p1', 'moved-recording.mp4', Date.now() - 45 * DAY);
        share(root, 'w1:p1', 'shared-today.png', Date.now() - MINUTE);

        const { run } = await runArtifactRetention({ rootDir: root, reportPath, epochMs: installed, now: Date.now() });

        expect(run.removedCount).toBe(0);
        expect(readdirSync(join(root, 'w1:p1')).sort()).toEqual(['moved-recording.mp4', 'shared-today.png']);
    });

    it('takes the count bound first, then empties an abandoned pane by age alone', async () => {
        const { root, reportPath } = home();
        // Minutes apart and strictly after the install, so a coarse filesystem
        // clock cannot put a file outside the epoch.
        const installed = Date.now() - MINUTE;
        for (let index = 0; index < 55; index += 1) share(root, 'w1:p1', `shot-${index}.png`, installed + (index + 1) * MINUTE);
        await runArtifactRetention({ rootDir: root, reportPath, now: installed });

        // A week on: the count bound takes the five past the newest 50.
        const counted = await runArtifactRetention({ rootDir: root, reportPath, now: installed + 8 * DAY });
        expect(counted.run.removedCount).toBe(5);
        expect(readdirSync(join(root, 'w1:p1'))).toHaveLength(50);

        // A month on: no post-epoch file survives the age bound, so an abandoned
        // pane empties instead of holding 50 files for ever.
        const aged = await runArtifactRetention({ rootDir: root, reportPath, now: installed + 40 * DAY });
        expect(aged.run.removedCount).toBe(50);
        expect(readdirSync(join(root, 'w1:p1'))).toEqual([]);
    });

    it('records the prune time, never 0, as the epoch when a prune precedes the first sweep', async () => {
        const { root, reportPath } = home();
        // The prune runs a minute after the file entered the pane, so the pile
        // it looks at is out of scope for every sweep that follows it.
        const prunedAt = Date.now() + MINUTE;
        share(root, 'w1:p1', 'legacy-recording.mp4', prunedAt - 20 * DAY);

        const prune = await runArtifactRetention({ rootDir: root, reportPath, epochMs: 0, now: prunedAt });
        expect(prune.run.epochMs).toBe(0);
        expect(prune.report.epochMs).toBe(prunedAt);
        expect(prune.report.lastPrune).not.toBeNull();
        expect(prune.report.lastSweep).toBeNull();

        // The scheduled sweep plans against the prune time, not the whole disk.
        const sweep = await runArtifactRetention({ rootDir: root, reportPath, now: prunedAt + 40 * DAY });
        expect(sweep.run.epochMs).toBe(prunedAt);
        expect(sweep.run.removedCount).toBe(0);
        expect(readdirSync(join(root, 'w1:p1'))).toEqual(['legacy-recording.mp4']);
    });

    it('deletes nothing and leaves the report alone when it is unreadable', async () => {
        const { root, reportPath } = home();
        share(root, 'w1:p1', 'old.png', Date.now() - 45 * DAY);
        await runArtifactRetention({ rootDir: root, reportPath, epochMs: Date.now() - 90 * DAY, now: Date.now() });

        // A crash or a full filesystem mid-write leaves the report truncated.
        const truncated = '{"version":1,"epochMs":';
        writeFileSync(reportPath, truncated);
        await expect(runArtifactRetention({ rootDir: root, reportPath })).rejects.toThrow(/unreadable/);

        expect(readdirSync(join(root, 'w1:p1'))).toEqual(['old.png']);
        expect(readFileSync(reportPath, 'utf8')).toBe(truncated);
    });
});
