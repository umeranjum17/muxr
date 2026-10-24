/**
 * The stable release gate: a release ships only when a judged receipt proves
 * the code it ships on the real phone.
 *
 * The check is model-free and reads git objects only. It never asks a model
 * anything, never needs a key, and never installs a dependency: the publish
 * job runs it on a bare checkout. What it proves is narrow and exact:
 *
 * - a receipt is committed for this release, in the shape done-done writes;
 * - the judge passed every capture the receipt cites;
 * - one of the capture runs drove the release's own phone journey;
 * - the receipt was sealed against the tree of the commit it names, and that
 *   commit is an ancestor of the release commit;
 * - nothing but release metadata changed between the proved commit and the
 *   release commit, so the proof still covers the code that ships;
 * - the journey ran this exact build: the receipt cites, by digest, the
 *   committed journey result for the release's version, and that result
 *   names the APK and npm tarball digests the release ships, every step
 *   passed, exactly one host alive, and attach and scroll times in budget;
 * - or it ran the release's x86_64 twin: the release also commits the
 *   release APK check, which names both APK digests, a journey APK
 *   built from the release commit, and the released APK's static checks;
 *   every functional step must pass there, and its times are reported,
 *   labelled emulator-under-load, without gating.
 *
 * The receipt is a record, not a signature: a forged one is caught by the
 * merge gate that reviews it, not by this check. What this check refuses is
 * a release whose proof is missing, stale, unrelated, or about other code.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { apkCheckFault, apkCheckPath, buildResultFault, buildResultPath, RELEASE_JOURNEY, TWIN_BUDGETS, TWIN_TIMINGS } from '../domain/releaseJourney.mjs';
import { isReleaseMetadata, RECEIPT_DIR } from '../domain/releaseMetadata.mjs';

const git = (repo, args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });

const gitText = (repo, args) => {
    const result = git(repo, args);
    if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || '').trim();
        throw new Error(`git ${args.join(' ')} failed: ${detail}`);
    }
    return result.stdout;
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The commit a ref names, or undefined when the ref names nothing. */
function resolveCommit(repo, ref) {
    const result = git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
    if (result.status !== 0) return undefined;
    return result.stdout.trim();
}

const isAncestor = (repo, ancestor, descendant) => git(repo, ['merge-base', '--is-ancestor', ancestor, descendant]).status === 0;

const changedPaths = (repo, from, to) => gitText(repo, ['diff', '--name-only', from, to]).split('\n').filter(Boolean);

const treeOf = (repo, commit) => gitText(repo, ['rev-parse', `${commit}^{tree}`]).trim();

const commitTime = (repo, commit) => Number(gitText(repo, ['show', '-s', '--format=%ct', commit]).trim()) * 1000;

/** The receipts committed on a ref. */
function receiptPaths(repo, ref) {
    const listed = gitText(repo, ['ls-tree', '-r', '--name-only', ref, '--', `${RECEIPT_DIR}/`]);
    return listed.split('\n').filter((path) => path.endsWith('.json') && !path.startsWith(`${RECEIPT_DIR}/builds/`));
}

/**
 * Why a parsed receipt is not a well-formed passing receipt for the release
 * journey, or null. It mirrors the shape done-done writes: a schema, a
 * result, the captures it cites, the judge that passed them, and the runs
 * that produced them.
 */
export function receiptFault(receipt, journey) {
    if (!receipt || typeof receipt !== 'object') return 'it is not a receipt';
    if (receipt.schema !== 2) return `its schema is ${receipt.schema}, not 2`;
    if (receipt.result !== 'pass') return `its result is ${receipt.result}, not pass`;
    if (!Array.isArray(receipt.files) || !receipt.files.length) return 'it cites no capture';
    if (!receipt.files.every((file) => file && typeof file.path === 'string' && typeof file.sha256 === 'string')) {
        return 'a cited capture has no path and digest';
    }
    const judge = receipt.judge;
    if (!judge || typeof judge !== 'object') return 'it carries no judge block';
    if (typeof judge.route !== 'string' || typeof judge.model !== 'string') return 'its judge block names no judge';
    if (!['agent', 'model', 'session-only'].includes(judge.independence)) return `its judge independence is ${judge.independence}`;
    if (!Array.isArray(judge.verdicts) || !judge.verdicts.length) return 'its judge block holds no verdict';
    if (!judge.verdicts.every((verdict) => verdict && verdict.verdict === 'pass'
        && receipt.files.some((file) => file.path === verdict.path && file.sha256 === verdict.sha256))) {
        return 'its judge did not pass every capture the receipt cites';
    }
    if (!Array.isArray(receipt.runs) || !receipt.runs.length) return 'it records no capture run';
    if (!receipt.runs.every((run) => run && typeof run.run_id === 'string')) return 'a capture run is malformed';
    if (!receipt.runs.some((run) => run.journey === journey)) return `no capture run drove the ${journey} journey`;
    return null;
}

/**
 * Why the receipt does not cover the release commit, or null: the commit it
 * names must be an ancestor of the release, sealed against that commit's own
 * tree, and only release metadata may have changed since.
 */
function coverageFault(repo, release, receipt) {
    const head = receipt.head;
    if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) return 'it names no commit head';
    if (!isAncestor(repo, head, release)) return `its head ${head.slice(0, 12)} is not an ancestor of the release commit`;
    const tree = treeOf(repo, head);
    if (receipt.tree !== tree) return `it was sealed against tree ${String(receipt.tree).slice(0, 12)}, not ${tree.slice(0, 12)}`;
    const changed = changedPaths(repo, head, release).filter((path) => !isReleaseMetadata(path));
    if (changed.length) return `the release changed ${changed.join(', ')} after it proved the code`;
    const sealed = Date.parse(receipt.at);
    if (Number.isNaN(sealed)) return 'it records no time';
    if (sealed < commitTime(repo, head)) return 'it was sealed before the commit it proves';
    if (sealed > Date.now() + 60_000) return 'it is dated in the future';
    return null;
}

/**
 * Why a cited capture that lives in the repository is not the bytes the judge
 * saw, or null. Captures kept outside the repository (the usual case) are not
 * checked here: the gate sees the receipt, not the evidence root.
 */
function captureFault(repo, ref, receipt) {
    for (const file of receipt.files) {
        if (file.path.startsWith('<evidence root>/') || file.path.startsWith('/')) continue;
        let bytes;
        try {
            bytes = execFileSync('git', ['show', `${ref}:${file.path}`], { cwd: repo, encoding: 'buffer' });
        } catch {
            return `its cited capture ${file.path} is not committed`;
        }
        if (sha256(bytes) !== file.sha256) return `its cited capture ${file.path} changed after the judge saw it`;
    }
    return null;
}

/**
 * Why the committed journey result does not prove this exact build, or null.
 * The receipt must cite the result's own bytes, so a result edited after the
 * judge saw the run counts for nothing. The APK check is a static record any
 * reviewer can recompute (checkReleaseApk.mjs) and lands beside the result:
 * done-done cites only what a run wrote, and the tag's journey cannot write it.
 */
function buildFault(receipt, result, apkCheck, build) {
    if (result === undefined) return `no journey result is committed at ${buildResultPath(build.version)}`;
    if (!receipt.files.some((file) => file.sha256 === result.sha256)) return `it does not cite the journey result ${buildResultPath(build.version)}`;
    // A journey on another APK counts only through a committed check that the
    // released APK passed its static checks and the cited run drove its same-commit twin.
    if (result.value?.build?.apk === build.apk || build.apk === undefined || apkCheck === undefined) return buildResultFault(result.value, build);
    const fault = apkCheckFault(apkCheck.value, build);
    if (fault) return `${apkCheckPath(build.version)}: ${fault}`;
    return buildResultFault(result.value, { ...build, apk: apkCheck.value.journeyApk.sha256 }, TWIN_BUDGETS);
}

/** A JSON record committed at a path, with its digest, or undefined. */
function readRecord(repo, ref, path) {
    let bytes;
    try {
        bytes = execFileSync('git', ['show', `${ref}:${path}`], { cwd: repo, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
        return undefined;
    }
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { value = null; }
    return { sha256: sha256(bytes), value };
}

/**
 * Check that a release commit and its exact build are covered by a committed
 * receipt for the release journey. `build` is `{ version, commit, apk, package }`:
 * the commit the release was sealed from and the sha256 digests of the APK and
 * npm tarball it ships. Returns
 * `{ ok: true, path, receipt, timings? }` (timings only for a twin run) or
 * `{ ok: false, reason }` naming every
 * receipt that was considered and why it did not count.
 */
export function checkJourneyReceipt({ repo = process.cwd(), commit = 'HEAD', receiptsRef = 'origin/main', journey = RELEASE_JOURNEY, build } = {}) {
    if (!/^[0-9A-Za-z.+-]{1,120}$/.test(build?.version ?? '')) return { ok: false, reason: 'the release names no build version to check' };
    const release = resolveCommit(repo, commit);
    if (!release) return { ok: false, reason: `${commit} names no commit` };
    const ref = resolveCommit(repo, receiptsRef) ?? release;
    const paths = receiptPaths(repo, ref);
    if (!paths.length) return { ok: false, reason: `no receipt is committed in ${RECEIPT_DIR} on ${receiptsRef}` };
    const result = readRecord(repo, ref, buildResultPath(build.version));
    const apkCheck = readRecord(repo, ref, apkCheckPath(build.version));
    const faults = [];
    for (const path of paths) {
        let receipt;
        try {
            receipt = JSON.parse(gitText(repo, ['show', `${ref}:${path}`]));
        } catch (error) {
            faults.push(`${path}: it is not readable JSON (${error instanceof Error ? error.message : String(error)})`);
            continue;
        }
        const fault = receiptFault(receipt, journey) ?? coverageFault(repo, release, receipt) ?? captureFault(repo, ref, receipt)
            ?? buildFault(receipt, result, apkCheck, build);
        if (fault) {
            faults.push(`${path}: ${fault}`);
            continue;
        }
        // A twin run's times are kept, labelled, never gated: the owner's phone test is the timing gate.
        const twin = result.value.build?.apk !== build.apk;
        return { ok: true, path, receipt, head: receipt.head, ...(twin ? { timings: { basis: TWIN_TIMINGS, ...result.value.timings } } : {}) };
    }
    return { ok: false, reason: faults.join('\n') };
}
