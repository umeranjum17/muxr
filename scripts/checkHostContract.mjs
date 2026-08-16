/**
 * Pre-delivery host/APK contract compatibility gate.
 *
 *   node scripts/checkHostContract.mjs <candidateCommit> <hostReleaseDir>
 *
 * Compares the full client request-type set of an exact APK candidate commit
 * (packages/contract/src/requests.ts in git) against the request-type set the
 * host's BUILT dispatcher actually exports in an exact immutable release
 * directory (~/.muxr/releases/host/<sha>/). Fails if the APK asks for
 * anything the host cannot answer, including the generic plugin bridge.
 *
 * No deps beyond node stdlib + git. Fails closed: every input must be exact
 * (full 40-hex commit, release dir whose basename and release.json commit
 * agree, SHA256SUMS re-verified), and the emitted dispatcher must parse
 * cleanly or the gate errors instead of guessing.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const RELEASE_JSON = 'release.json';
const CONTRACT_PATH = 'packages/contract/src/requests.ts';
const DISPATCHER_PATH = 'apps/host/dist/requests/createRequestDispatcher.js';
// Generic plugin control must exist on both the candidate and built host.
const REQUIRED_TYPES = ['plugin.list', 'plugin.manifest', 'plugin.approve', 'plugin.invoke', 'plugin.call'];
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// RequestMap keys and emitted handlers keys are `'name':` at a fixed indent.
const KEY_LINE = /^\s*'([A-Za-z0-9.]+)':/;

const fail = (message) => {
    process.stderr.write(`\nFAIL: ${message}\n`);
    process.exit(1);
};

function git(args) {
    try {
        return execFileSync('git', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch (error) {
        fail(`git ${args.join(' ')}: ${String(error.stderr ?? error).trim()}`);
    }
}

function extractKeys(text, from, to) {
    const keys = new Set();
    let capturing = from === undefined;
    for (const line of text.split('\n')) {
        if (!capturing && line.includes(from)) {
            capturing = true;
            continue;
        }
        if (capturing) {
            if (to !== undefined && line.trim() === to) break;
            const match = line.match(KEY_LINE);
            if (match) keys.add(match[1]);
        }
    }
    return keys;
}

const [candidate, releaseDirArg] = process.argv.slice(2);
if (candidate === undefined || releaseDirArg === undefined) {
    fail(`usage: node scripts/checkHostContract.mjs <candidateCommit> <hostReleaseDir>\n       (candidateCommit must be a full 40-hex git commit; hostReleaseDir an immutable release dir with release.json + SHA256SUMS)`);
}

// --- exact candidate commit (reject short shas, branch names, anything ambiguous) ---
if (!FULL_SHA.test(candidate)) {
    fail(`candidate '${candidate}' is not a full 40-hex commit sha (rejecting ambiguous refs; pass the exact sha)`);
}
const resolved = git(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
if (resolved !== candidate) {
    fail(`candidate ${candidate} does not resolve to that exact commit (resolved to '${resolved}')`);
}
const dirty = git(['status', '--porcelain=v1', '--untracked-files=all']);
if (dirty !== '') {
    fail('candidate worktree is dirty; commit the exact combined candidate before running the delivery gate');
}
if (git(['rev-parse', 'HEAD']) !== candidate) {
    fail(`candidate ${candidate} is not the checked-out HEAD; check out the exact candidate before running the gate`);
}
const contractBlob = git(['rev-parse', `${candidate}:${CONTRACT_PATH}`]);
const contractSource = git(['show', `${candidate}:${CONTRACT_PATH}`]);
const apkTypes = extractKeys(contractSource);
if (apkTypes.size < 10) {
    fail(`could not robustly parse request types from ${candidate}:${CONTRACT_PATH} (got ${apkTypes.size}); refusing to guess`);
}

// --- exact immutable host artifact dir ---
const releaseDir = resolve(releaseDirArg);
if (!existsSync(releaseDir) || !existsSync(join(releaseDir, RELEASE_JSON))) {
    fail(`host release dir ${releaseDir} does not exist or has no ${RELEASE_JSON}`);
}
if (!FULL_SHA.test(basename(releaseDir))) {
    fail(`release dir basename '${basename(releaseDir)}' is not a full 40-hex sha`);
}
const release = JSON.parse(readFileSync(join(releaseDir, RELEASE_JSON), 'utf8'));
if (typeof release.commit !== 'string' || release.commit !== basename(releaseDir)) {
    fail(`release.json commit '${String(release.commit)}' does not match release dir basename '${basename(releaseDir)}' (dir is not an exact immutable release)`);
}
if (!existsSync(join(releaseDir, 'SHA256SUMS'))) fail(`release dir ${releaseDir} has no SHA256SUMS`);
const sums = readFileSync(join(releaseDir, 'SHA256SUMS'), 'utf8').split('\n').filter((line) => line.trim() !== '');
if (sums.length === 0) fail(`SHA256SUMS is empty`);
for (const line of sums) {
    const [hash, ...pathParts] = line.split(/\s+/);
    const rel = pathParts.join(' ');
    if (!SHA256_HEX.test(hash) || rel === '' || rel.startsWith('/') || rel.includes('..')) {
        fail(`unparseable SHA256SUMS line: '${line}'`);
    }
    const actual = createHash('sha256').update(readFileSync(join(releaseDir, rel))).digest('hex');
    if (actual !== hash) fail(`SHA256SUMS mismatch: ${rel} (expected ${hash}, got ${actual}) -- release dir is not the immutable artifact`);
}
const dispatcherPath = join(releaseDir, DISPATCHER_PATH);
if (!existsSync(dispatcherPath)) {
    fail(`release has no built dispatcher at ${DISPATCHER_PATH} (was it built?)`);
}
const hostTypes = extractKeys(readFileSync(dispatcherPath, 'utf8'), 'const handlers = {', '};');
if (hostTypes.size < 10) {
    fail(`could not robustly parse the emitted dispatcher handlers at ${DISPATCHER_PATH} (got ${hostTypes.size}); refusing to guess`);
}

// --- compare: APK requests must all exist on the host ---
const missing = [...apkTypes].filter((type) => !hostTypes.has(type)).sort();
const extra = [...hostTypes].filter((type) => !apkTypes.has(type)).sort();
const missingRequired = REQUIRED_TYPES.filter((type) => !apkTypes.has(type) || !hostTypes.has(type));


const lines = [
    '',
    `candidate APK commit: ${resolved}`,
    `  contract file blob: ${contractBlob} (${CONTRACT_PATH})`,
    `  APK request types : ${apkTypes.size}`,
    `host release dir    : ${releaseDir}`,
    `  release.json commit: ${release.commit} (createdAt ${String(release.createdAt ?? '?')}, source ${String(release.source ?? '?')}, node ${String(release.node ?? '?')})`,
    `  SHA256SUMS verified: ${sums.length} files`,
    `  host handler types : ${hostTypes.size}`,
    `  plugin bridge      : ${REQUIRED_TYPES.every((type) => apkTypes.has(type) && hostTypes.has(type)) ? 'complete' : 'INCOMPLETE'}`,
];

if (missing.length > 0) {
    lines.push('', `FAIL: APK requests missing on host (${missing.length}):`, ...missing.map((t) => `  - ${t}`));
    process.stderr.write(lines.join('\n') + '\n');
    process.exit(1);
}
if (missingRequired.length > 0) {
    lines.push('', `FAIL: required plugin bridge types missing on one side: ${missingRequired.join(', ')}`);
    process.stderr.write(lines.join('\n') + '\n');
    process.exit(1);
}

lines.push(
    `  host-only extra    : ${extra.length === 0 ? 'none' : extra.join(', ')}`,
    `  required plugin set: ${missingRequired.length === 0 ? REQUIRED_TYPES.join(', ') : 'MISSING: ' + missingRequired.join(', ')}`,
    '',
    'PASS: every APK request type, including the generic plugin bridge, has a built host handler.',
);
process.stdout.write(lines.join('\n') + '\n');
