/**
 * Shared Artifacts retention.
 *
 * Every pane keeps every file its agents ever shared, for ever. On the desk
 * that is already 257 pane directories, 21,491 files and 38 GiB of APKs and
 * recordings, so the sweep below bounds the growth. It is deliberately
 * conservative, because deletion is irreversible and nothing in muxr can bring
 * a file back.
 *
 * - Only files that entered a pane *after* retention was installed here
 *   (`epochMs`) are ever candidates. The pile that already existed is left
 *   exactly as it is; an operator can sweep it deliberately with
 *   `muxr artifacts prune`, which is the only path that ignores the epoch.
 * - Scope and age read the inode change time, not the modification time: an
 *   agent that *moves* a file into a pane keeps its old mtime, and reading that
 *   as "shared weeks ago" would delete it before anyone saw it. The kernel
 *   stamps the change time on rename and link and userspace cannot set it back,
 *   so it is never earlier than the moment the file arrived. Order, rank and
 *   the report keep the modification time, which is what the phone shows.
 * - Three bounds, all applied: the newest `keepNewest` files of a pane are
 *   exempt from the count bound (the timeline only ever lists that many, so
 *   nothing it can reach is dropped for being old), no file younger than
 *   `minAgeMs` is touched at all, and nothing post-epoch survives `maxAgeMs` or
 *   the per-pane `keepBytes` ceiling. `keepNewest` must stay at least the
 *   watcher's `MAX_ARTIFACTS`, which `artifactRetention.test.ts` holds.
 * - The age floor is also what keeps a half-written file out of reach: a
 *   download, a recording, or the temp inode `muxr share` copies through cannot
 *   be a week old, so no in-flight write is ever a candidate.
 * - The pass stats names and never reads a byte. Hashing this root costs 17 GiB
 *   of I/O; a sweep that read every file would be a second expensive pass beside
 *   the one the watcher already runs.
 *
 * What it removed, and the policy it removed it under, land in a report beside
 * the muxr home (`muxr artifacts` prints it) and in one host log line per sweep.
 * Files never disappear in silence.
 */

import { randomUUID } from 'node:crypto';
import { readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

export const ARTIFACT_RETENTION_REPORT_FILE = 'artifact-retention.json';

export interface ArtifactRetentionPolicy {
    /** Never remove anything younger than this. */
    minAgeMs: number;
    /** Remove anything this old, whatever its rank. */
    maxAgeMs: number;
    /** The newest N files of a pane are exempt from the count bound. */
    keepNewest: number;
    /** Per-pane ceiling for the files retention may remove. */
    keepBytes: number;
    /** How often the host sweeps. */
    intervalMs: number;
    /** Wait this long after boot before the first sweep. */
    firstRunDelayMs: number;
    /** Removals recorded in the report, newest first; the rest are only counted. */
    reportLimit: number;
}

export const ARTIFACT_RETENTION: ArtifactRetentionPolicy = {
    minAgeMs: 7 * 24 * 60 * 60_000,
    maxAgeMs: 30 * 24 * 60 * 60_000,
    keepNewest: 50,
    keepBytes: 512 * 1024 * 1024,
    intervalMs: 24 * 60 * 60_000,
    firstRunDelayMs: 5 * 60_000,
    reportLimit: 200,
};

export interface ArtifactFile {
    name: string;
    size: number;
    /** mtime ms, the same clock the watcher orders by. */
    at: number;
    /**
     * Inode change time ms: when the file entered this pane. A move or a link
     * updates it and userspace cannot set it back, so scope and age are judged
     * by it while display and rank stay on `at`.
     */
    changedAt: number;
}

export interface ArtifactSweepPlan {
    remove: ArtifactFile[];
    removedBytes: number;
    kept: number;
}

/**
 * Which of a pane's files the policy gives up.
 *
 * A file goes when it entered the pane after the retention epoch, it has been
 * there longer than `minAgeMs`, and it breaks one of the three bounds: it is
 * older than `maxAgeMs`, it ranks past the newest `keepNewest`, or its removal
 * is what brings the pane back under `keepBytes`. The newest `keepNewest` files
 * are therefore exempt from the count bound only: an idle pane full of
 * month-old APKs still empties, because the age bound is the one that bounds
 * it. Scope and both age bounds read the change time; the rank that decides the
 * count bound reads the modification time the timeline orders by.
 *
 * Pure: the whole rule set is here, so the daily sweep and an operator prune
 * cannot drift apart.
 */
export function planArtifactSweep(
    files: readonly ArtifactFile[],
    options: { epochMs: number; now: number; policy?: ArtifactRetentionPolicy },
): ArtifactSweepPlan {
    const policy = options.policy ?? ARTIFACT_RETENTION;
    const { epochMs, now } = options;
    // Pre-epoch files are the accumulation the policy leaves alone; they are not
    // candidates and they do not count against a bound, so a legacy pile can
    // never push a newly shared file out.
    const inScope = files.filter((file) => file.changedAt > epochMs);
    const newestFirst = [...inScope].sort((left, right) => right.at - left.at || (left.name < right.name ? -1 : 1));
    const candidates = newestFirst
        .map((file, rank) => ({ file, rank }))
        .filter(({ file }) => now - file.changedAt >= policy.minAgeMs);

    const remove = new Set(candidates
        .filter(({ file, rank }) => rank >= policy.keepNewest || now - file.changedAt >= policy.maxAgeMs)
        .map(({ file }) => file));
    let remaining = inScope.reduce((total, file) => total + file.size, 0)
        - [...remove].reduce((total, file) => total + file.size, 0);
    // Oldest first: the newest candidates are the ones most likely to still be
    // the one the user meant.
    for (const { file } of [...candidates].reverse()) {
        if (remaining <= policy.keepBytes) break;
        if (remove.has(file)) continue;
        remove.add(file);
        remaining -= file.size;
    }
    const removed = newestFirst.filter((file) => remove.has(file));
    return {
        remove: removed,
        removedBytes: removed.reduce((total, file) => total + file.size, 0),
        kept: files.length - removed.length,
    };
}

export interface ArtifactSweepRecord {
    paneId: string;
    name: string;
    size: number;
    at: number;
}

export interface ArtifactRetentionRun {
    at: number;
    /** What the sweep was allowed to consider: the epoch, or 0 for a prune. */
    epochMs: number;
    panes: number;
    removedCount: number;
    removedBytes: number;
    /** Newest first, at most `policy.reportLimit`. */
    removed: ArtifactSweepRecord[];
    kept: number;
}

export interface ArtifactRetentionReport {
    version: 1;
    /** When retention was first installed here. Files that entered a pane before this are never swept. */
    epochMs: number;
    policy: ArtifactRetentionPolicy;
    lastSweep: ArtifactRetentionRun | null;
    /** Set only by an operator-run `muxr artifacts prune`, which ignores the epoch. */
    lastPrune: ArtifactRetentionRun | null;
}

export type ArtifactRetentionReportState =
    | { state: 'ok'; report: ArtifactRetentionReport }
    | { state: 'missing' }
    /** Present but not a readable report: sweeps pause instead of resetting the epoch. */
    | { state: 'unreadable' };

export async function readArtifactRetentionReport(path: string): Promise<ArtifactRetentionReportState> {
    let text: string;
    try {
        text = await readFile(path, 'utf8');
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable' };
    }
    try {
        const parsed = JSON.parse(text) as ArtifactRetentionReport;
        return parsed?.version === 1 && typeof parsed.epochMs === 'number'
            ? { state: 'ok', report: parsed }
            : { state: 'unreadable' };
    } catch {
        return { state: 'unreadable' };
    }
}

/**
 * Sweep every pane under `rootDir` once.
 *
 * `epochMs` defaults to the epoch recorded in the report, and is written there
 * the first time this runs. Passing `0` sweeps everything on disk and is an
 * operator prune, never the scheduled path; a prune that lands before the first
 * sweep still records the time it ran as the epoch, so the sweeps after it do
 * not inherit the prune's whole-disk scope.
 */
export async function runArtifactRetention(options: {
    rootDir: string;
    reportPath: string;
    epochMs?: number;
    policy?: ArtifactRetentionPolicy;
    now?: number;
    /** Plan only: report what would go and touch nothing, including the report. */
    dryRun?: boolean;
}): Promise<{ run: ArtifactRetentionRun; report: ArtifactRetentionReport }> {
    const policy = options.policy ?? ARTIFACT_RETENTION;
    const now = options.now ?? Date.now();
    const stored = await readArtifactRetentionReport(options.reportPath);
    if (stored.state === 'unreadable') {
        // Fail safe: an unreadable report is not an absent one. Sweeping now
        // would stamp a fresh epoch and put the whole existing history back in
        // scope, so nothing is deleted and the file is left for its owner.
        throw new Error(`retention report at ${options.reportPath} is unreadable; sweeps are paused until it is fixed`);
    }
    const existing = stored.state === 'ok' ? stored.report : undefined;
    const prune = options.epochMs === 0;
    const epochMs = prune ? 0 : options.epochMs ?? existing?.epochMs ?? now;
    const root = resolve(options.rootDir);

    const paneIds = await listPanes(root);
    const removed: ArtifactSweepRecord[] = [];
    let removedCount = 0;
    let removedBytes = 0;
    let kept = 0;
    for (const paneId of paneIds) {
        const dir = resolve(root, paneId);
        if (!dir.startsWith(`${root}${sep}`)) continue;
        const result = await sweepPane(dir, paneId, { epochMs, now, policy, dryRun: options.dryRun === true });
        kept += result.kept;
        removedCount += result.removed.length;
        removedBytes += result.removed.reduce((total, record) => total + record.size, 0);
        removed.push(...result.removed);
    }
    // Newest first across every pane, then capped: the report is what an
    // operator reads to see what the sweep took.
    const reported = removed
        .sort((left, right) => right.at - left.at || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
        .slice(0, policy.reportLimit);

    const run: ArtifactRetentionRun = {
        at: now,
        epochMs,
        panes: paneIds.length,
        removedCount,
        removedBytes,
        removed: reported,
        kept,
    };
    const report: ArtifactRetentionReport = {
        version: 1,
        epochMs: existing?.epochMs ?? (prune ? now : epochMs),
        policy,
        lastSweep: prune ? existing?.lastSweep ?? null : run,
        lastPrune: prune ? run : existing?.lastPrune ?? null,
    };
    if (options.dryRun !== true) {
        try {
            await writeArtifactRetentionReport(options.reportPath, report);
        } catch {
            // An unwritable report must not cost the sweep its removals; the log
            // line still carries the summary.
        }
    }
    return { run, report };
}

/**
 * Replace the report in one step, so a crash or a full filesystem leaves the
 * previous report and its epoch exactly as they were.
 */
async function writeArtifactRetentionReport(path: string, report: ArtifactRetentionReport): Promise<void> {
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
        await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, path);
    } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
}

/**
 * The host's cadence: one sweep shortly after boot, then daily. Both timers are
 * unref'd, so retention never keeps the process alive.
 */
export function startArtifactRetention(options: {
    rootDir: string;
    reportPath: string;
    onSweep?: (run: ArtifactRetentionRun) => void;
    policy?: ArtifactRetentionPolicy;
}): () => void {
    const policy = options.policy ?? ARTIFACT_RETENTION;
    let sweeping = false;
    const sweep = async (): Promise<void> => {
        if (sweeping) return;
        sweeping = true;
        try {
            const { run } = await runArtifactRetention({ rootDir: options.rootDir, reportPath: options.reportPath, ...(options.policy === undefined ? {} : { policy: options.policy }) });
            options.onSweep?.(run);
        } catch (error) {
            process.stderr.write(`artifact retention failed: ${error instanceof Error ? error.message : String(error)}\n`);
        } finally {
            sweeping = false;
        }
    };
    const first = setTimeout(() => void sweep(), policy.firstRunDelayMs);
    const interval = setInterval(() => void sweep(), policy.intervalMs);
    first.unref();
    interval.unref();
    return () => {
        clearTimeout(first);
        clearInterval(interval);
    };
}

async function listPanes(root: string): Promise<string[]> {
    try {
        return (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
        return [];
    }
}

async function sweepPane(
    dir: string,
    paneId: string,
    options: { epochMs: number; now: number; policy: ArtifactRetentionPolicy; dryRun: boolean },
): Promise<{ removed: ArtifactSweepRecord[]; kept: number }> {
    let entries: import('node:fs').Dirent[];
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return { removed: [], kept: 0 };
    }
    const files: ArtifactFile[] = [];
    for (const entry of entries) {
        // Hidden names are in-flight temp inodes (`muxr share` copies through
        // one); the watcher ignores them and so does retention.
        if (!entry.isFile() || entry.name.startsWith('.')) continue;
        try {
            const info = await stat(join(dir, entry.name));
            if (info.isFile()) {
                files.push({
                    name: entry.name,
                    size: info.size,
                    at: Math.floor(info.mtimeMs),
                    changedAt: Math.floor(info.ctimeMs),
                });
            }
        } catch {
            // A file that vanished between readdir and stat is not a sweep failure.
        }
    }
    const plan = planArtifactSweep(files, options);
    const removed: ArtifactSweepRecord[] = [];
    for (const file of plan.remove) {
        if (!options.dryRun) {
            try {
                await unlink(join(dir, file.name));
            } catch {
                // Already gone, or not ours to remove. Leave it and keep going.
                continue;
            }
        }
        removed.push({ paneId, name: file.name, size: file.size, at: file.at });
    }
    return { removed, kept: files.length - removed.length };
}
