#!/usr/bin/env node
/** Prepare one explicitly owned, warm session for the development surface probe. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CommandScope, useCommandScope } from './lib/commands.mjs';
import { setAndroidSerial, androidArgs } from './lib/deviceTarget.mjs';
import { apkIdentity, harnessIdentity, iosAppIdentity, patchedDependencies, runtimeIdentity, sha256, sourceIdentity } from './lib/provenance.mjs';
import { acquireOwnerLock, processStartIdentity } from './lib/surfaceProbe.mjs';
import { startFakeStack } from './lib/fakeStack.mjs';
import { pairPhone } from './lib/pairPhone.mjs';
import { pairIosPhone, iosConnectionProof } from './lib/iosWarm.mjs';
import { command, IosControls } from './lib/iosSignals.mjs';
import { documentContract, documentPayload, DOCUMENT_FIXTURE, LOAD, scenarioDescriptor, scenarioSummary } from './lib/scenario.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const platform = flag('--platform', 'android');
const serial = flag('--serial');
const udid = flag('--udid');
const apk = flag('--apk');
const app = flag('--app');
const bundle = flag('--bundle', 'com.trymuxr.app');
const packageName = flag('--package', 'com.trymuxr.app');
const candidateManifestPath = flag('--candidate-manifest');
const hostBuildPath = flag('--host-build');
const descriptorPath = resolve(flag('--descriptor', `/tmp/muxr-probe-session-${platform}-${serial ?? udid}.json`));
const scope = new CommandScope();
useCommandScope(scope);
let releaseLock;
let lockOwner;
let stack;
let descriptorWritten = false;

const readJson = (path, label) => {
    if (!path || !existsSync(path)) throw new Error(`${label} is missing: ${path ?? '(not supplied)'}`);
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`); }
};
const adb = async (argv, options = {}) => (await scope.run('adb', androidArgs(argv), options)).stdout;
const git = async (argv, cwd) => (await scope.run('git', ['-C', cwd, ...argv], { timeout: 20_000 })).stdout.trim();
const hashObject = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requiredHash = (value, name) => { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) throw new Error(`${name} is missing or invalid`); };

function validateHostBuild(manifest, source, harness, runtime) {
    if (manifest.version !== 1 || manifest.kind !== 'muxr.host-build' || manifest.buildCommand !== 'yarn build' || manifest.source?.dirty !== false) throw new Error('host build evidence is not an explicit clean yarn build');
    requiredHash(manifest.source?.sourceSha256, 'host-build sourceSha256');
    requiredHash(manifest.source?.mobileSha256, 'host-build mobileSha256');
    if (manifest.source.sourceSha256 !== source.sourceSha256 || manifest.source.mobileSha256 !== source.mobileSha256) throw new Error('host build source does not match this checkout');
    if (JSON.stringify(manifest.harness) !== JSON.stringify(harness)) throw new Error('host build harness identity does not match this checkout');
    if (JSON.stringify(manifest.runtime) !== JSON.stringify(runtime)) throw new Error('host build runtime identity does not match disk');
}
function validateCandidateManifest(manifest, artifact, source) {
    if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== 1) throw new Error('candidate manifest schema version is unsupported');
    requiredHash(manifest.sourceSha256, 'candidate sourceSha256');
    requiredHash(manifest.mobileSha256, 'candidate mobileSha256');
    if (manifest.dirty !== false || manifest.sourceSha256 !== source.sourceSha256 || manifest.mobileSha256 !== source.mobileSha256) throw new Error('candidate build evidence does not match this clean checkout');
    if (manifest.nativeDependencies === undefined || JSON.stringify(manifest.nativeDependencies) !== JSON.stringify(patchedDependencies('.'))) throw new Error('candidate native dependency evidence does not match this checkout');
    if (typeof manifest.signer !== 'string' && typeof manifest.buildMode !== 'string') throw new Error('candidate manifest has no signing/build-mode evidence');
    const digest = manifest.apkSha256 ?? manifest.appSha256 ?? manifest.binarySha256 ?? manifest.artifact?.sha256;
    if (digest !== artifact.sha256) throw new Error('candidate manifest artifact bytes do not match candidate');
    if (manifest.variant !== undefined && manifest.variant !== 'release') throw new Error('candidate manifest is not a release build');
    for (const field of ['package', 'versionCode', 'versionName', 'signerDigest', 'bundle', 'version', 'build', 'jsSha256', 'resourcesSha256']) {
        if (manifest[field] !== undefined && manifest[field] !== artifact[field]) throw new Error(`candidate manifest ${field} does not match candidate`);
    }
}

async function androidCandidate(source) {
    setAndroidSerial(serial);
    if ((await adb(['get-state'])).trim() !== 'device') throw new Error(`Android serial ${serial} is not booted`);
    const artifact = await apkIdentity(apk);
    if (artifact.package !== packageName) throw new Error(`candidate package ${artifact.package} is not ${packageName}`);
    const manifest = readJson(candidateManifestPath ?? `${artifact.path}.json`, 'candidate manifest');
    validateCandidateManifest(manifest, artifact, source);
    const remote = (await adb(['shell', 'pm', 'path', packageName])).trim().replace(/^package:/, '');
    if (!remote) throw new Error(`package ${packageName} is not installed on ${serial}`);
    const scratch = mkdtempSync(join(tmpdir(), 'muxr-probe-installed-'));
    try {
        const pulled = join(scratch, 'installed.apk');
        await scope.run('adb', androidArgs(['pull', remote, pulled]), { timeout: 30_000 });
        const installed = { ...await apkIdentity(pulled), remotePath: remote };
        for (const field of ['package', 'versionCode', 'versionName', 'signerDigest', 'sha256']) if (installed[field] !== artifact[field]) throw new Error(`installed APK ${field} differs from candidate`);
        const dump = await adb(['shell', 'dumpsys', 'package', packageName]);
        if (!dump.includes(`versionName=${artifact.versionName}`) || !dump.includes(`versionCode=${artifact.versionCode}`)) throw new Error('installed package metadata differs from candidate');
        return { serial, package: packageName, artifact, installed, manifest };
    } finally { rmSync(scratch, { recursive: true, force: true }); }
}

async function iosCandidate(source) {
    const devices = JSON.parse(await command('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']));
    const booted = Object.values(devices.devices ?? {}).flat().find((device) => device.udid === udid && device.state === 'Booted');
    if (!booted) throw new Error(`iOS simulator ${udid} is not booted`);
    const artifact = await iosAppIdentity(app);
    if (artifact.bundle !== bundle) throw new Error(`app bundle ${artifact.bundle} is not ${bundle}`);
    const manifest = readJson(candidateManifestPath ?? `${resolve(app)}.json`, 'candidate manifest');
    validateCandidateManifest(manifest, artifact, source);
    const container = (await command('xcrun', ['simctl', 'get_app_container', udid, bundle, 'app'])).trim();
    if (!container) throw new Error(`bundle ${bundle} is not installed on ${udid}`);
    const installed = await iosAppIdentity(container);
    for (const field of ['bundle', 'version', 'build', 'sha256', 'jsSha256', 'resourcesSha256']) if (installed[field] !== artifact[field]) throw new Error(`installed app ${field} differs from candidate`);
    return { udid, bundle, artifact, installed, manifest };
}

async function prepareFixture() {
    const cwd = stack.world.cwd;
    const path = join(cwd, DOCUMENT_FIXTURE);
    writeFileSync(path, documentPayload());
    await git(['init', '-q', '-b', 'main'], cwd);
    await git(['add', '--', DOCUMENT_FIXTURE], cwd);
    await scope.run('git', ['-C', cwd, '-c', 'user.name=Perf Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Seed deterministic load document'], { timeout: 20_000 });
    const context = JSON.stringify({ sessions: [{ cwd }] });
    const env = { ...process.env, MUXR_PLUGIN_CONTEXT_JSON: context };
    const repos = JSON.parse((await scope.run(process.execPath, [join(process.cwd(), 'plugins/code/files.mjs'), 'repos'], { cwd: process.cwd(), env, timeout: 10_000 })).stdout);
    if (!repos.repos?.some((entry) => resolve(entry.root) === resolve(cwd))) throw new Error('real Files plugin did not resolve the fixture repository');
    const listed = JSON.parse((await scope.run(process.execPath, [join(process.cwd(), 'plugins/code/files.mjs'), 'list'], { cwd: process.cwd(), env, input: JSON.stringify({ cwd, root: cwd }) })).stdout);
    if (!listed.tree?.some((entry) => entry.name === DOCUMENT_FIXTURE)) throw new Error('real Files plugin did not list the canonical fixture');
    const read = JSON.parse((await scope.run(process.execPath, [join(process.cwd(), 'plugins/code/files.mjs'), 'read'], { cwd: process.cwd(), env, input: JSON.stringify({ cwd, root: cwd, path: DOCUMENT_FIXTURE }) })).stdout);
    const contract = documentContract();
    const served = Buffer.from(read.body ?? '');
    const expected = Buffer.from(documentPayload()).subarray(0, contract.servedBytes);
    if (read.name !== DOCUMENT_FIXTURE || served.compare(expected) !== 0 || served.length !== contract.servedBytes || served.toString('utf8').split('\n').filter(Boolean).length !== contract.servedLines) throw new Error('real Files plugin served bytes or lines differ from scenario');
    return { cwd: resolve(cwd), gitRevision: await git(['rev-parse', 'HEAD'], cwd), gitTree: await git(['rev-parse', 'HEAD^{tree}'], cwd), name: DOCUMENT_FIXTURE, payloadSha256: contract.sha256, servedSha256: hashObject(served.toString('utf8')), servedBytes: served.length, servedLines: contract.servedLines };
}

function writeDescriptor(value) {
    if (existsSync(descriptorPath)) throw new Error(`descriptor already exists: ${descriptorPath}`);
    mkdirSync(dirname(descriptorPath), { recursive: true });
    const temporary = `${descriptorPath}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, descriptorPath);
    descriptorWritten = true;
}

async function main() {
    if (!['android', 'ios'].includes(platform)) throw new Error('--platform must be android or ios');
    if (platform === 'android' && (!serial || !apk)) throw new Error('Android preparation requires --serial and --apk');
    if (platform === 'ios' && (!udid || !app || !bundle)) throw new Error('iOS preparation requires --udid, --app and --bundle');
    if (!hostBuildPath) throw new Error('--host-build is required after an explicit successful yarn build');
    const currentSource = sourceIdentity('.');
    const currentHarness = harnessIdentity('.');
    const currentRuntime = runtimeIdentity('.');
    validateHostBuild(readJson(hostBuildPath, 'host build evidence'), currentSource, currentHarness, currentRuntime);
    if (existsSync(descriptorPath)) throw new Error(`descriptor already exists: ${descriptorPath}`);
    const device = platform === 'android' ? await androidCandidate(currentSource) : await iosCandidate(currentSource);
    const lockPath = resolve(flag('--lock', `/tmp/muxr-surface-probe-${platform}-${serial ?? udid}.lock`));
    const owner = { pid: process.pid, descriptor: descriptorPath, platform, device: serial ?? udid };
    releaseLock = acquireOwnerLock(lockPath, owner);
    lockOwner = releaseLock.owner;
    stack = await startFakeStack({ ...LOAD, sourceRoot: process.cwd(), transport: platform === 'ios' ? 'loopback' : undefined, pluginsRoot: join(process.cwd(), 'plugins') });
    if (stack.fixturePanes?.text === undefined || stack.fixturePanes?.graphics === undefined) throw new Error('the herd published no text/graphics fixture panes');
    const fixture = await prepareFixture();
    let paired;
    if (platform === 'android') {
        const maestro = (flow, variables = {}) => new Promise((done, reject) => {
            const child = scope.spawn('mise', ['x', 'maestro@cli-2.7.0', '--', 'maestro', '--device', serial, 'test', ...Object.entries(variables).flatMap(([key, value]) => ['-e', `${key}=${value}`]), join('perf/flows', flow)], { env: { ...process.env, ANDROID_HOME: process.env.ANDROID_HOME ?? join(process.env.HOME, 'Android/Sdk') }, stdio: ['ignore', 'pipe', 'pipe'] });
            const output = []; child.stdout.on('data', (chunk) => output.push(String(chunk))); child.stderr.on('data', (chunk) => output.push(String(chunk))); child.once('error', reject); child.once('close', (code) => code === 0 ? done({ code, output: output.join('') }) : reject(new Error(`Maestro exited ${code}: ${output.join('').slice(-400)}`)));
        });
        paired = await pairPhone({ stack, maestro });
        if (!paired.ok) throw new Error(`pairing failed: ${paired.why}`);
    } else {
        const ui = new IosControls(udid);
        const initialNodes = await ui.ui();
        const root = initialNodes.find((node) => node.type === 'Application' && node.frame?.width > 0 && node.frame?.height > 0) ?? initialNodes.find((node) => node.frame?.x === 0 && node.frame?.y === 0 && node.frame?.width > 0 && node.frame?.height > 0);
        if (!root) throw new Error('iOS AX root geometry is unavailable');
        ui.setGeometry(root.frame.width, root.frame.height);
        paired = await pairIosPhone({ stack, udid, bundle, ui });
        const proof = await iosConnectionProof(ui, [...stack.world.agents.map((row) => row.name), ...stack.world.panes.map((row) => row.label)]);
        if (!proof.connected || proof.fixture === undefined) throw new Error('iOS app did not show the connected herd and fixture identity');
    }
    const world = { world: stack.world, fixturePanes: stack.fixturePanes };
    const descriptor = {
        version: 1, startedAt: new Date().toISOString(), pid: process.pid, pidStartIdentity: processStartIdentity(process.pid), platform, device,
        scenario: scenarioDescriptor(), candidate: { source: currentSource, harness: currentHarness, artifact: device.artifact, installed: device.installed, manifest: device.manifest, manifestPath: resolve(candidateManifestPath ?? `${device.artifact.path}.json`) },
        hostBuild: readJson(hostBuildPath, 'host build evidence'),
        host: { relayPort: stack.relayPort, dataDir: stack.dataDir, cwd: fixture.cwd, fixturePanes: stack.fixturePanes, world: stack.world, pids: { relay: stack.pids.relay, host: stack.pids.host, herdr: stack.herdrPid }, pidIdentities: { relay: processStartIdentity(stack.pids.relay), host: processStartIdentity(stack.pids.host), herdr: processStartIdentity(stack.herdrPid) }, childHealth: stack.childHealth().filter((entry) => entry.name !== 'pair'), attachJsonl: stack.attachJsonl, graphicsInputJsonl: stack.graphicsInputJsonl, inputJsonl: stack.inputJsonl, cellMetricsJsonl: stack.cellMetricsJsonl, worldIdentityPath: stack.worldIdentityPath, worldIdentity: hashObject(world), identity: stack.identity, fixture },
        plugins: runtimeIdentity('.'), paired, lock: lockPath, lockOwner: lockOwner, probeLock: join(lockPath, 'active-probe'), worldWitness: stack.worldIdentityPath,
    };
    writeDescriptor(descriptor);
    process.stdout.write(`${scenarioSummary()}\nherd up: ${stack.world.panes.length} panes, ${stack.world.agents.length} agents\nsession ready: ${descriptorPath}\n`);
    process.stdout.write(`probe it with: node perf/surfaceProbe.mjs --session ${descriptorPath} --platform ${platform} --${platform === 'android' ? 'serial' : 'udid'} ${serial ?? udid} --surface document\n`);
    await new Promise(() => {});
}

async function teardown(code = 0) {
    let closed = true;
    try { await scope.close(); } catch (error) { closed = false; process.stderr.write(`probe session cleanup incomplete: ${error.message}\n`); }
    if (closed) {
        try { scope.cleanup(); } catch (error) { closed = false; process.stderr.write(`probe session cleanup failed: ${error.message}\n`); }
    }
    if (closed) {
        if (descriptorWritten) try { rmSync(descriptorPath, { force: true }); } catch { /* preserve if removal races */ }
        releaseLock?.();
    }
    process.exit(code);
}
process.once('SIGINT', () => void teardown(0));
process.once('SIGTERM', () => void teardown(0));
main().catch(async (error) => { process.stderr.write(`probe session failed: ${error.message}\n`); await teardown(1); });
