/**
 * `muxr artifacts` — what Shared Artifacts retention is doing on this machine.
 *
 * The host sweeps daily on its own. This command exists so the policy and every
 * removal are readable instead of files silently disappearing, and so the pile
 * that already existed can be cleared deliberately rather than automatically.
 *
 * The rules live in one compiled host module, imported here rather than
 * re-implemented, so the scheduled sweep and this command cannot drift.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Same layout rule as `muxr skill`: packaged copies sit beside us, source does not. */
function retentionModulePath() {
    const packaged = join(here, '..', 'artifacts', 'retention.mjs');
    if (existsSync(packaged)) return packaged;
    return join(here, '..', '..', 'apps', 'host', 'dist', 'agent', 'infrastructure', 'artifactRetention.js');
}

function muxrHome() {
    return process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr');
}

function fail(message) {
    process.stderr.write(`muxr artifacts: ${message}\n`);
    process.exitCode = 1;
}

function usage() {
    process.stderr.write(
        "usage: muxr artifacts [status]\n"
        + '       muxr artifacts prune [--dry-run] [--yes]\n\n'
        + 'status  the retention policy and what the last sweep removed (default)\n'
        + 'prune   sweep the files that existed before retention was installed. Deletes\n'
        + '        files, so it always shows the plan first; --yes skips the question.\n',
    );
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function policyLines(policy) {
    const days = (ms) => {
        const count = Math.round(ms / 86_400_000);
        return `${count} day${count === 1 ? '' : 's'}`;
    };
    return [
        `  keeps the newest        ${policy.keepNewest} files of every pane`,
        `  removes past that when  older than ${days(policy.minAgeMs)}`,
        `  removes regardless when older than ${days(policy.maxAgeMs)}`,
        `  per-pane ceiling        ${formatBytes(policy.keepBytes)} of removable files`,
        `  sweeps every            ${days(policy.intervalMs)}`,
    ];
}

function runLines(label, run) {
    if (run === null || run === undefined) return [`${label}: none yet`];
    const when = new Date(run.at).toISOString();
    const scope = run.epochMs === 0 ? 'every file on disk' : `files shared after ${new Date(run.epochMs).toISOString()}`;
    const lines = [
        `${label}:`,
        `  at          ${when}`,
        `  scope       ${scope}`,
        `  panes       ${run.panes}`,
        `  removed     ${run.removedCount} file${run.removedCount === 1 ? '' : 's'} (${formatBytes(run.removedBytes)})`,
        `  kept        ${run.kept}`,
    ];
    if (run.removedCount > run.removed.length) {
        lines.push(`  newest ${run.removed.length} removed:`);
    }
    for (const record of run.removed) {
        lines.push(`    ${record.paneId}/${record.name}  ${formatBytes(record.size)}  ${new Date(record.at).toISOString()}`);
    }
    return lines;
}

async function status() {
    const { readArtifactRetentionReport, ARTIFACT_RETENTION } = await import(pathToFileURL(retentionModulePath()).href);
    const report = await readArtifactRetentionReport(join(muxrHome(), 'artifact-retention.json'));
    const policy = report?.policy ?? ARTIFACT_RETENTION;
    process.stdout.write(`Shared Artifacts retention\n${policyLines(policy).join('\n')}\n\n`);
    if (report === undefined) {
        process.stdout.write('No sweep has run on this machine yet. The host starts one a few minutes after it boots.\n');
        return 0;
    }
    process.stdout.write(`Files shared before ${new Date(report.epochMs).toISOString()} are out of scope and are never swept.\n\n`);
    process.stdout.write(`${runLines('Last sweep', report.lastSweep).join('\n')}\n`);
    if (report.lastPrune !== null && report.lastPrune !== undefined) {
        process.stdout.write(`\n${runLines('Last prune', report.lastPrune).join('\n')}\n`);
    } else {
        process.stdout.write('\nThis machine has never run `muxr artifacts prune`.\n');
    }
    return 0;
}

async function prune(args) {
    const dryRun = args.includes('--dry-run');
    const assumeYes = args.includes('--yes');
    for (const arg of args) if (arg !== '--dry-run' && arg !== '--yes') {
        usage();
        fail(`unknown option: ${arg}`);
        return 1;
    }
    const { runArtifactRetention } = await import(pathToFileURL(retentionModulePath()).href);
    const home = muxrHome();
    const sweepOptions = {
        // The pre-rename on-disk path is a contract with muxr share and the
        // agent skills; the artifact vocabulary stops at the code.
        rootDir: join(home, 'attachments', 'pane'),
        reportPath: join(home, 'artifact-retention.json'),
        // 0 is the whole point: a prune considers the files retention would
        // otherwise leave alone. Only an operator can ask for this.
        epochMs: 0,
    };
    const plan = await runArtifactRetention({ ...sweepOptions, dryRun: true });
    if (plan.run.removedCount === 0) {
        process.stdout.write('Nothing to prune: every pane is already inside the retention policy.\n');
        return 0;
    }
    process.stdout.write(`${runLines('Prune plan', plan.run).join('\n')}\n`);
    if (dryRun) {
        process.stdout.write('\n--dry-run: nothing was removed.\n');
        return 0;
    }
    if (!assumeYes) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
            fail('this deletes files; re-run non-interactively with --yes once the plan above looks right');
            return 1;
        }
        const { select } = await import('../setup/index.mjs');
        const confirmed = await select(`Remove those ${plan.run.removedCount} files? This cannot be undone.`, [
            { value: 'cancel', title: 'Cancel', description: 'leave every file in place' },
            { value: 'yes', title: 'Remove them', description: 'apply the retention policy to the existing history' },
        ]);
        if (confirmed !== 'yes') {
            process.stdout.write('Cancelled. Nothing was removed.\n');
            return 0;
        }
    }
    const applied = await runArtifactRetention(sweepOptions);
    process.stdout.write(`Removed ${applied.run.removedCount} file${applied.run.removedCount === 1 ? '' : 's'} (${formatBytes(applied.run.removedBytes)}).\n`);
    process.stdout.write('Recorded in ' + join(home, 'artifact-retention.json') + '\n');
    return 0;
}

export async function artifacts(args = []) {
    process.exitCode = 0;
    const [command = 'status', ...rest] = args;
    if (command === '--help' || command === '-h' || command === 'help') {
        usage();
        return 0;
    }
    try {
        if (command === 'status') return await status();
        if (command === 'prune') return await prune(rest);
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
        return 1;
    }
    usage();
    fail(`unknown command: ${command}`);
    return 1;
}
