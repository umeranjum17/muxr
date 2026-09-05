/** Phone-requested exact-release repair. Only packaged, managed Linux hosts apply. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../../setup/infrastructure/runtime.mjs';
import { releaseVersion } from '../domain/channel.mjs';

export const releaseCompatibility = Object.freeze({ protocol: 1, state: 1 });
const packageRoot = () => join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const npmBin = () => process.env.MUXR_NPM_BIN?.trim() || 'npm';
function run(binary, args, timeout = 15000) {
    return execFileSync(binary, args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function privateDir(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error('Host update directory must be private and owned by this account.');
    return path;
}
function save(path, value) {
    const temp = `${path}.${randomUUID()}`;
    writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); renameSync(temp, path);
}
function installed() {
    const root = realpathSync(packageRoot());
    const manifest = read(join(root, 'package.json'));
    if (manifest.name !== '@trymuxr/cli' || manifest.muxrCompatibility?.protocol !== releaseCompatibility.protocol || manifest.muxrCompatibility?.state !== releaseCompatibility.state || !existsSync(join(root, 'cli.mjs'))) throw new Error('Install a packaged host before using phone updates.');
    if (realpathSync(join(run(npmBin(), ['root', '--global']), '@trymuxr/cli')) !== root) throw new Error('This host uses a different npm installation. Update it from its original Node environment.');
    return { root, manifest };
}
function targetMetadata(version) {
    const target = readJsonOutput(run(npmBin(), ['view', `@trymuxr/cli@${version}`, 'version', 'muxrCompatibility', 'dist.integrity', '--json']));
    if (target.version !== version || target.muxrCompatibility?.protocol !== releaseCompatibility.protocol
        || target.muxrCompatibility?.state !== releaseCompatibility.state || typeof target['dist.integrity'] !== 'string') {
        throw new Error('This release does not declare compatible host protocol and state. No automatic downgrade is available.');
    }
    return target;
}
function readJsonOutput(value) { try { return JSON.parse(value); } catch { throw new Error('The release registry returned invalid metadata.'); } }
function managed() {
    if (process.platform !== 'linux') throw new Error('Phone updates currently require the managed Linux host service.');
    run('systemctl', ['--user', 'is-active', 'muxr.service']);
}
function loadPlan(id, owner) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid update plan.');
    const path = join(privateDir(join(stateDir(), 'updates')), `${id}.json`);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 32768) throw new Error('Invalid update record.');
    const plan = read(path);
    if (plan.owner !== digest(owner)) throw new Error('This update belongs to another paired device.');
    return { path, plan };
}
function publicResult(plan) {
    return { planId: plan.id, currentVersion: plan.current, targetVersion: plan.target, status: plan.status,
        compatible: plan.protocol === releaseCompatibility.protocol, canApply: plan.status === 'ready',
        message: plan.message, direction: plan.direction };
}
function journalPath() { return join(resolve(process.env.MUXR_DATA_DIR?.trim() || join(stateDir(), 'host')), 'diagnostics.json'); }
function hostHealthy(version, path, after = 0) {
    try {
        const journal = read(path).current;
        return journal.hostVersion === version && journal.relayState === 'open' && Date.parse(journal.startedAt) >= after;
    } catch { return false; }
}
function reconcile(path, plan) {
    if (!['queued', 'updating', 'rolling-back', 'needs-attention'].includes(plan.status)) return plan;
    // Give systemd-run time to register the unit before judging it interrupted.
    if (Date.now() - (plan.queuedAt ?? plan.createdAt) < 30_000) return plan;
    let active;
    try { active = run('systemctl', ['--user', 'show', '--property=ActiveState', '--value', `muxr-update-${plan.id}.service`]); }
    catch { active = 'unknown'; }
    if (['active', 'activating', 'reloading', 'deactivating'].includes(active)) return plan;
    const lock = join(dirname(path), 'active');
    // Never release another job's lock, nor an installer whose state is unknown.
    let job;
    let heldLock = true;
    try { job = read(join(lock, 'job.json')); } catch {
        if (existsSync(lock)) return plan;
        // A completed worker failure removes its lock; keep using its recorded
        // health path so a healthy prior install can be retried from the phone.
        heldLock = false;
        job = plan;
    }
    if (job.id !== plan.id) return plan;
    if (!['inactive', 'failed', ''].includes(active)) {
        plan.status = 'needs-attention'; plan.message = 'Cannot confirm the update service stopped. The update lock is retained; check the host service.';
        save(path, plan); return plan;
    }
    let version;
    try { version = installed().manifest.version; } catch { /* partially installed package */ }
    const healthy = [plan.current, plan.target].includes(version) && hostHealthy(version, job.journalPath);
    plan.status = healthy ? version === plan.target ? 'complete' : 'interrupted' : 'needs-attention';
    plan.message = healthy ? version === plan.target ? 'Host aligned and connected.' : 'The update stopped. The previous host is healthy; tap Check compatibility to try again.'
        : 'The update stopped and host health is unconfirmed. Its lock and private state snapshot are retained; repair the host service before retrying.';
    save(path, plan);
    if (healthy && heldLock) {
        // Recheck after npm/health inspection; absence never grants ownership.
        try { if (read(join(lock, 'job.json')).id === plan.id) rmSync(lock, { recursive: true, force: true }); } catch { /* another reconciler completed cleanup */ }
    }
    return plan;
}
export async function repairHost(request) {
    if (!request || typeof request.owner !== 'string' || !request.owner || request.owner.length > 256) throw new Error('Authenticated device required.');
    if (request.action === 'status') { const { path, plan } = loadPlan(request.planId, request.owner); return publicResult(reconcile(path, plan)); }
    if (request.action === 'plan') {
        const { manifest } = installed();
        const current = releaseVersion(manifest.version);
        if (request.protocol !== releaseCompatibility.protocol) throw new Error('App protocol is unsupported by this host. Choose a compatible mobile release.');
        const compatible = (message, targetVersion = request.appVersion) => ({ currentVersion: current.version, targetVersion, status: 'compatible', compatible: true, canApply: false, message });
        let version;
        try { version = releaseVersion(request.appVersion); }
        catch { return compatible('App and host share a compatible protocol. This app has no exact release identity, so automatic host alignment is unavailable.'); }
        if (version.version === current.version) return compatible('App and host are already on the same compatible release.');
        if (version.channel !== current.channel) return compatible('App and host share a compatible protocol. Optional alignment would change release channels; switch channels explicitly on the host first.');
        let metadata;
        try { managed(); metadata = targetMetadata(version.version); }
        catch { return compatible('App and host share a compatible protocol. No verified managed-host alignment is available for this exact app release. You can keep using this connection.'); }
        const id = randomUUID();
        const plan = { id, owner: digest(request.owner), current: current.version, target: version.version, channel: current.channel,
            protocol: request.protocol, integrity: metadata['dist.integrity'], createdAt: Date.now(), status: 'ready',
            direction: 'align', message: 'These releases share a compatible protocol. Alignment is optional. This keeps your app and channel, installs its exact host release, and briefly reconnects all paired devices.' };
        save(join(privateDir(join(stateDir(), 'updates')), `${id}.json`), plan);
        return publicResult(plan);
    }
    if (request.action !== 'apply') throw new Error('Unknown host update action.');
    const { path, plan } = loadPlan(request.planId, request.owner);
    if (plan.status !== 'ready') return publicResult(plan);
    const { manifest, root } = installed(); managed();
    if (Date.now() - plan.createdAt > 10 * 60_000 || plan.current !== manifest.version) throw new Error('Update plan expired or the installed host changed. Check again.');
    if (targetMetadata(plan.target)['dist.integrity'] !== plan.integrity) throw new Error('Published release changed. Check again.');
    const lock = join(privateDir(join(stateDir(), 'updates')), 'active');
    try { mkdirSync(lock, { mode: 0o700 }); } catch { throw new Error('A host update is already running. Check its status before trying again.'); }
    try {
        const job = join(lock, 'job.json');
        plan.journalPath = journalPath();
        save(job, { ...plan, path, root });
        plan.queuedAt = Date.now(); plan.status = 'queued'; plan.message = 'Host alignment queued. The app will reconnect after the service restarts.'; save(path, plan);
        // A transient service survives the muxr.service restart. A detached
        // child alone remains in its parent's systemd cgroup and would be killed.
        const env = ['HOME', 'PATH', 'MUXR_HOME', 'MUXR_DATA_DIR'].filter((key) => process.env[key]).map((key) => `--setenv=${key}=${process.env[key]}`);
        run('systemd-run', ['--user', '--collect', '--quiet', `--unit=muxr-update-${plan.id}`, ...env,
            process.execPath, join(root, 'release/application/repairHost.mjs'), '--worker', job]);
    } catch { plan.status = 'needs-attention'; plan.message = 'Update service startup could not be confirmed. Its lock and record are retained; check the host before retrying.'; save(path, plan); }
    return publicResult(plan);
}
async function worker(jobPath) {
    const lock = dirname(jobPath), job = read(jobPath);
    const update = (status, message) => { job.status = status; job.message = message; save(job.path, job); };
    const snapshot = () => {
    const backup = privateDir(join(dirname(job.path), `${job.id}-snapshot`));
    for (const name of ['auth.json', 'selfhost.json', 'setup-manifest.json']) {
        const source = join(stateDir(), name);
        if (!existsSync(source)) continue;
        const info = lstatSync(source);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error('Cannot snapshot host state.');
        writeFileSync(join(backup, name), readFileSync(source), { flag: 'wx', mode: 0o600 });
    }
    };
    const apply = (version) => spawnSync(process.execPath, [join(job.root, 'cli.mjs'), 'update', '--to', version, '--channel', job.channel, '--allow-downgrade', '--yes'], {
        timeout: 240000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'ignore', 'ignore'], env: process.env,
    }).status === 0;
    const healthy = async (version) => {
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
            if (hostHealthy(version, job.journalPath, job.startedAt)) return true;
            await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        return false;
    };
    try {
        if (installed().manifest.version !== job.current || targetMetadata(job.target)['dist.integrity'] !== job.integrity) throw new Error('Update source changed before execution.');
        snapshot();
        job.startedAt = Date.now(); update('updating', 'Installing the exact host release. Your saved identity is preserved.');
        if (apply(job.target) && await healthy(job.target)) { update('complete', 'Host aligned and connected.'); return; }
        update('rolling-back', 'The updated host did not become healthy. Restoring the previous package.');
        // State schema equality is mandatory. Keep current state, including any
        // newly enrolled device; never overwrite it with a stale snapshot.
        const rollback = spawnSync(npmBin(), ['install', '--global', '--ignore-scripts', `@trymuxr/cli@${job.current}`], { timeout: 240000, stdio: 'ignore' });
        run(process.execPath, [join(job.root, 'cli.mjs'), 'daemon', 'restart'], 30000);
        update(rollback.status === 0 && await healthy(job.current) ? 'rolled-back' : 'needs-attention', 'Alignment failed. Check host status; a private state snapshot is retained.');
    } catch { update('needs-attention', 'Host alignment stopped. Check the host before retrying; the private snapshot is retained.'); }
    finally { rmSync(lock, { recursive: true, force: true }); }
}
if (process.argv[2] === '--worker') {
    try { await worker(process.argv[3]); } catch { process.exitCode = 1; }
}
