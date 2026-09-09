import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync, closeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createInterface } from 'node:readline';
import { checkPlugin } from './checkPlugin.mjs';
import { parsePluginId } from '../domain/dist/index.js';

export const MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 2048;
const NPM_NAME_RE = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const INTEGRITY_RE = /^(?:sha256|sha512)-[A-Za-z0-9+/=]+$/;
const herdrBin = () => process.env.HERDR_BIN?.trim() || 'herdr';
const muxrHome = () => resolve(process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr'));
const extensionHome = () => join(muxrHome(), 'extensions');
const provenanceHome = () => join(extensionHome(), '.provenance');
const fail = (message) => { throw new Error(message); };

export function parseNpmSpec(spec) {
    if (typeof spec !== 'string' || !spec.startsWith('npm:')) return undefined;
    const match = spec.slice(4).match(/^(@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|[A-Za-z0-9._-]+)@(.*)$/);
    if (!match || !NPM_NAME_RE.test(match[1]) || !VERSION_RE.test(match[2])) fail('npm packages require an exact registry version, for example npm:@scope/name@1.2.3');
    return { kind: 'npm', name: match[1], version: match[2] };
}
function isPathLike(spec) { return spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..' || /^[A-Za-z]:[\\/]/.test(spec); }
function parseGithubSpec(spec) {
    if (typeof spec !== 'string' || spec.startsWith('npm:') || isPathLike(spec)) return undefined;
    const at = spec.lastIndexOf('@');
    const source = at > 0 ? spec.slice(0, at) : spec;
    const ref = at > 0 ? spec.slice(at + 1) : undefined;
    const pieces = source.split('/');
    if (pieces.length < 2 || pieces.length > 3 || pieces.some((part) => !/^[A-Za-z0-9._-]+$/.test(part))) return undefined;
    if (ref !== undefined && (!ref || /[\0\r\n\t ]/.test(ref) || ref.length > 200)) fail('invalid GitHub ref');
    return { kind: 'github', source, owner: pieces[0], repo: pieces[1], subdir: pieces[2], ref };
}

function runHerdr(args) {
    const result = spawnSync(herdrBin(), args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
    if (result.error) fail(`could not run Herdr: ${result.error.message}`);
    if (result.status !== 0) fail((result.stderr || result.stdout || `herdr exited ${result.status}`).trim());
    return { stdout: result.stdout || '', stderr: result.stderr || '' };
}
function runHerdrOptional(args) {
    const result = spawnSync(herdrBin(), args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
    if (result.error) fail(`could not run Herdr: ${result.error.message}`);
    return { ok: result.status === 0, stdout: result.stdout || '', stderr: result.stderr || '' };
}
function parseJsonOutput(text) {
    const start = text.search(/[\[{]/);
    if (start < 0) fail('Herdr returned no JSON');
    try { return JSON.parse(text.slice(start)); } catch (error) { fail(`invalid Herdr JSON: ${error instanceof Error ? error.message : String(error)}`); }
}
export function herdrPlugins() {
    const parsed = parseJsonOutput(runHerdr(['plugin', 'list', '--json']).stdout);
    const result = parsed?.result ?? parsed;
    const plugins = Array.isArray(result) ? result : result?.plugins;
    if (!Array.isArray(plugins)) fail('Herdr plugin list did not contain plugins');
    return plugins.filter((plugin) => plugin && typeof plugin.plugin_id === 'string');
}
const pluginFor = (plugins, id) => plugins.find((plugin) => plugin.plugin_id === id);
const stableJson = (value) => Array.isArray(value) ? `[${value.map(stableJson).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}` : JSON.stringify(value);
function authorityIdentity(plugin) { return stableJson({ build: plugin.build ?? [], startup: plugin.startup ?? [], actions: plugin.actions ?? [], events: plugin.events ?? [], panes: plugin.panes ?? [], links: plugin.link_handlers ?? [] }); }
function extensionSummary(plugin, source = plugin.source ?? { kind: 'local' }) {
    return JSON.stringify({ pluginId: plugin.plugin_id, name: plugin.name, version: plugin.version, source, root: plugin.plugin_root, enabled: plugin.enabled === true, warnings: plugin.warnings ?? [], authority: JSON.parse(authorityIdentity(plugin)) }, null, 2);
}
function isManagedDirectory(path) {
    try {
        const stat = lstatSync(path);
        return stat.isDirectory() && !stat.isSymbolicLink();
    } catch { return false; }
}
function ensureManagedDirectory(path, label) {
    try { mkdirSync(path, { recursive: true, mode: 0o700 }); } catch { /* lstat below reports the useful rejection */ }
    if (!isManagedDirectory(path)) fail(`${label} must be a non-symlink directory`);
    return path;
}
function validRoot(root, base = extensionHome()) {
    if (!isManagedDirectory(base)) return undefined;
    let real, expected;
    try {
        real = realpathSync(root);
        expected = realpathSync(base);
    } catch { return undefined; }
    const rel = relative(expected, real);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.includes('\\') || rel.split('/').length !== 1) return undefined;
    return real;
}
function nofollowJson(path, maxBytes = 8192) {
    try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return undefined;
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { return JSON.parse(readFileSync(fd, 'utf8')); } finally { closeSync(fd); }
    } catch { return undefined; }
}
function validNpmProvenance(plugin) {
    const root = validRoot(plugin.plugin_root);
    let expectedRoot;
    try { expectedRoot = join(realpathSync(extensionHome()), plugin.plugin_id); } catch { return undefined; }
    if (!root || !isManagedDirectory(provenanceHome()) || !plugin.plugin_id || !parsePluginId(plugin.plugin_id).ok || root !== expectedRoot) return undefined;
    const value = nofollowJson(join(provenanceHome(), `${plugin.plugin_id}.json`));
    if (!value || value.schemaVersion !== 1 || value.pluginId !== plugin.plugin_id || value.root !== root || typeof value.name !== 'string' || typeof value.version !== 'string' || typeof value.integrity !== 'string' || value.name.length > 200 || value.version.length > 80 || value.integrity.length > 200 || !NPM_NAME_RE.test(value.name) || !VERSION_RE.test(value.version) || !INTEGRITY_RE.test(value.integrity)) return undefined;
    return value;
}
function sourceFor(plugin) {
    const npm = validNpmProvenance(plugin);
    return npm ? { kind: 'npm', name: npm.name, version: npm.version, integrity: npm.integrity } : plugin.source ?? { kind: 'local' };
}
function isNpmRoot(plugin) {
    const root = validRoot(plugin?.plugin_root);
    if (root === undefined || typeof plugin?.plugin_id !== 'string') return false;
    try { return root === join(realpathSync(extensionHome()), plugin.plugin_id); }
    catch { return false; }
}

function lockPath(id) { return join(extensionHome(), '.locks', `${id}.lock`); }
function ownerIsLive(path) {
    const meta = nofollowJson(join(path, 'owner.json'), 2048);
    if (!Number.isInteger(meta?.pid) || meta.pid <= 0) return false;
    try { process.kill(meta.pid, 0); return true; }
    catch (error) { return error?.code !== 'ESRCH'; }
}
function acquireLock(id) {
    ensureManagedDirectory(extensionHome(), '$MUXR_HOME/extensions');
    const parent = ensureManagedDirectory(join(extensionHome(), '.locks'), '$MUXR_HOME/extensions/.locks');
    const path = lockPath(id);
    for (let attempt = 0; attempt < 32; attempt += 1) {
        // Prepare ownership out of band, then publish it with one atomic rename.
        const prepared = mkdtempSync(join(parent, `.claim-${process.pid}-`));
        writeNoFollow(join(prepared, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 0o600);
        try {
            renameSync(prepared, path);
            return () => rmSync(path, { recursive: true, force: true });
        } catch (error) {
            rmSync(prepared, { recursive: true, force: true });
            if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
            let stat;
            try { stat = lstatSync(path); } catch { continue; }
            if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`package ${id} lock is not a directory`);
            if (ownerIsLive(path)) fail(`package ${id} is already being changed`);
            // Rename the stale lock away atomically; never recursively delete the live target.
            const stale = join(parent, `.stale-${process.pid}-${randomUUID()}`);
            try { renameSync(path, stale); } catch (reclaimError) {
                if (reclaimError?.code === 'ENOENT' || reclaimError?.code === 'EEXIST') continue;
                throw reclaimError;
            }
            rmSync(stale, { recursive: true, force: true });
        }
    }
    fail(`package ${id} lock could not be claimed; retry`);
}
async function withLock(id, action) { const release = acquireLock(id); try { return await action(); } finally { release(); } }
async function withRegistryLock(id, action) { return withLock('.registry-global', () => withLock(id, action)); }

function writeNoFollow(path, data, mode = 0o600) {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try { writeSync(fd, data); } finally { closeSync(fd); }
}
function atomicProvenance(id, value) {
    ensureManagedDirectory(extensionHome(), '$MUXR_HOME/extensions');
    ensureManagedDirectory(provenanceHome(), '$MUXR_HOME/extensions/.provenance');
    const temp = join(provenanceHome(), `.${id}.${process.pid}.tmp`);
    writeNoFollow(temp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temp, join(provenanceHome(), `${id}.json`));
}
function removeProvenanceFile(path) {
    if (!isManagedDirectory(provenanceHome())) return;
    try {
        const stat = lstatSync(path);
        if (!stat.isSymbolicLink()) rmSync(path, { force: true });
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}
function removeProvenance(id) { removeProvenanceFile(join(provenanceHome(), `${id}.json`)); }
function removeProvenanceTemp(id) { removeProvenanceFile(join(provenanceHome(), `.${id}.${process.pid}.tmp`)); }
function backupProvenance(id, parent) {
    if (!isManagedDirectory(provenanceHome())) return undefined;
    const path = join(provenanceHome(), `${id}.json`);
    try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
    } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
    const backup = join(parent, 'provenance.json');
    renameSync(path, backup);
    return backup;
}
function restoreProvenance(id, backup) {
    removeProvenance(id);
    if (backup && existsSync(backup)) renameSync(backup, join(provenanceHome(), `${id}.json`));
}

function paxFields(buffer) {
    const fields = {};
    let offset = 0;
    while (offset < buffer.length) {
        const end = buffer.indexOf(10, offset);
        if (end < 0) fail('invalid tar PAX metadata');
        const lineBytes = buffer.subarray(offset, end);
        const line = lineBytes.toString('utf8');
        const space = line.indexOf(' ');
        const equals = line.indexOf('=');
        const length = Number.parseInt(line.slice(0, space), 10);
        if (space < 1 || equals <= space || !Number.isSafeInteger(length) || length !== end - offset + 1) fail('invalid tar PAX metadata');
        fields[line.slice(space + 1, equals)] = line.slice(equals + 1);
        offset = end + 1;
    }
    return fields;
}
function parseOctal(buffer, start, length) {
    const text = buffer.subarray(start, start + length).toString('ascii').replace(/\0.*$/, '').trim();
    if (text === '') return 0;
    if (!/^[0-7]+$/.test(text)) fail('invalid tar numeric field');
    return Number.parseInt(text, 8);
}
function tarString(buffer, start, length) { return buffer.subarray(start, start + length).toString('utf8').replace(/\0.*$/, ''); }
function verifyTarChecksum(header) {
    const expected = parseOctal(header, 148, 8);
    const actual = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (expected === 0 || expected !== actual) fail('invalid npm tar checksum');
}
function archivePath(raw) {
    if (typeof raw !== 'string' || !raw || raw.includes('\0') || raw.includes('\\') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) fail('npm archive contains an unsafe path');
    const normalized = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    const parts = normalized.split('/');
    if (parts[0] !== 'package' || parts.some((part) => !part || part === '.' || part === '..')) fail('npm archive path must stay under package/');
    return parts.length === 1 ? '' : parts.slice(1).join('/');
}
export function readNpmArchive(archive) {
    if (!Buffer.isBuffer(archive)) archive = Buffer.from(archive);
    if (archive.length > MAX_COMPRESSED_BYTES) fail('npm archive exceeds the 16 MiB compressed limit');
    let tar;
    try { tar = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES + 512 * MAX_ARCHIVE_ENTRIES + 1024 }); } catch (error) { fail(`invalid npm archive: ${error instanceof Error ? error.message : String(error)}`); }
    const files = new Map(), seen = new Set(), globalPax = {};
    let pendingPax, offset = 0, entries = 0, unpacked = 0;
    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512); offset += 512;
        if (header.every((byte) => byte === 0)) break;
        entries += 1; if (entries > MAX_ARCHIVE_ENTRIES) fail('npm archive exceeds the 2,048 entry limit');
        verifyTarChecksum(header);
        const type = String.fromCharCode(header[156] || 48), headerSize = parseOctal(header, 124, 12);
        if (!Number.isSafeInteger(headerSize) || headerSize < 0 || headerSize > MAX_UNPACKED_BYTES) fail('invalid npm archive entry size');
        const blocks = Math.ceil(headerSize / 512); if (offset + blocks * 512 > tar.length) fail('truncated npm archive');
        const data = tar.subarray(offset, offset + headerSize); offset += blocks * 512;
        if (type === 'x' || type === 'g') { const pax = paxFields(data); if (type === 'g') Object.assign(globalPax, pax); else pendingPax = pax; continue; }
        if (!['0', '\0', '5'].includes(type)) fail('npm archive contains links or special files');
        const pax = { ...globalPax, ...(pendingPax ?? {}) }; pendingPax = undefined;
        const path = archivePath(pax.path ?? tarString(header, 0, 100));
        if (path === '') { if (type !== '5' || headerSize !== 0) fail('invalid npm archive package root'); continue; }
        if (seen.has(path)) fail(`npm archive contains duplicate path: ${path}`); seen.add(path);
        if (type === '5') { if (headerSize !== 0) fail('invalid npm archive directory'); continue; }
        const size = pax.size === undefined ? headerSize : Number(pax.size);
        if (!Number.isSafeInteger(size) || size < 0 || size !== data.length) fail('invalid npm archive PAX size');
        unpacked += size; if (unpacked > MAX_UNPACKED_BYTES) fail('npm archive exceeds the 64 MiB unpacked limit');
        const mode = parseOctal(header, 100, 8);
        files.set(path, { data: Buffer.from(data), mode });
    }
    if (files.size === 0) fail('npm archive contains no package files');
    return files;
}

function validatePackageJson(files, name, version) {
    const entry = files.get('package.json'); if (!entry) fail('npm package is missing package.json');
    let pkg; try { pkg = JSON.parse(entry.data.toString('utf8')); } catch { fail('npm package.json is invalid'); }
    if (pkg.name !== name || pkg.version !== version) fail('npm package metadata does not match the exact requested package');
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'bundle', 'bundled', 'bundleDependencies', 'bundledDependencies']) if (pkg[field] !== undefined) fail(`npm package dependency field is not allowed: ${field}`);
}
function materialize(files, target, name, version) {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const [path, entry] of files) {
        const destination = join(target, ...path.split('/'));
        const rel = relative(target, resolve(destination));
        if (rel.startsWith('..') || isAbsolute(rel)) fail('npm archive escaped its materialization root');
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        writeNoFollow(destination, entry.data, entry.mode & 0o111 ? 0o700 : 0o600);
    }
    validatePackageJson(files, name, version);
    return checkPlugin(target);
}
function verifyIntegrity(archive, integrity) {
    if (!INTEGRITY_RE.test(integrity ?? '')) fail('npm registry did not return a supported integrity hash');
    const [algorithm, encoded] = integrity.split('-', 2);
    if (createHash(algorithm).update(archive).digest('base64') !== encoded) fail('npm archive integrity does not match the registry response');
}
function packNpm(spec) {
    const scratch = mkdtempSync(join(tmpdir(), 'muxr-npm-pack-'));
    try {
        const scopedRegistry = spec.name.startsWith('@') ? [`--${spec.name.split('/')[0]}:registry=https://registry.npmjs.org/`] : [];
        const result = spawnSync('npm', ['pack', '--ignore-scripts', '--no-workspaces', '--registry=https://registry.npmjs.org/', ...scopedRegistry, '--json', `${spec.name}@${spec.version}`, '--pack-destination', scratch], { cwd: scratch, encoding: 'utf8' });
        if (result.status !== 0) fail((result.stderr || result.stdout || 'npm pack failed').trim());
        const metadata = parseJsonOutput(result.stdout)[0];
        if (!metadata || metadata.name !== spec.name || metadata.version !== spec.version || typeof metadata.filename !== 'string' || basename(metadata.filename) !== metadata.filename || metadata.filename.includes('\0') || metadata.filename.includes('/') || metadata.filename.includes('\\')) fail('npm registry returned unsafe package metadata');
        const archivePath = join(scratch, metadata.filename);
        const stat = lstatSync(archivePath); if (!stat.isFile() || stat.isSymbolicLink()) fail('npm pack did not return a regular archive');
        if (stat.size > MAX_COMPRESSED_BYTES) fail('npm archive exceeds the 16 MiB compressed limit');
        const archive = readFileSync(archivePath); verifyIntegrity(archive, metadata.integrity);
        return { files: readNpmArchive(archive), integrity: metadata.integrity };
    } finally { rmSync(scratch, { recursive: true, force: true }); }
}

function ask(question) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(false);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((answer) => rl.question(`${question} (y/N) `, (value) => { rl.close(); answer(value.trim().toLowerCase() === 'y'); }));
}
const confirm = (yes, text) => yes ? Promise.resolve(true) : ask(text);
function requireArgs(args, command) { const positional = args.filter((arg) => arg !== '--yes'); if (args.filter((arg) => arg === '--yes').length > 1 || positional.length !== 1 || args.some((arg) => arg !== '--yes' && typeof arg !== 'string')) fail(`muxr plugin ${command} requires one spec and optional --yes`); return { spec: positional[0], yes: args.includes('--yes') }; }
function pluginIdentity(plugin) {
    let root; try { root = realpathSync(plugin.plugin_root); } catch { return undefined; }
    return { root, source: sourceFor(plugin), authority: authorityIdentity(plugin) };
}
function summaryRecord(plugin, expectedRoot, expectedSource, expectedAuthority, expectedEnabled = false) {
    const identity = pluginIdentity(plugin);
    return Boolean(plugin.plugin_id && identity && identity.root === expectedRoot && plugin.enabled === expectedEnabled
        && stableJson(identity.source) === stableJson(expectedSource) && identity.authority === expectedAuthority);
}
function cleanupBackup(parent) {
    try { rmSync(parent, { recursive: true, force: true }); }
    catch (error) { process.stderr.write(`warning: could not clean package backup: ${error instanceof Error ? error.message : String(error)}\n`); }
}
function relinkAndVerify(id, root, expected, enabled) {
    runHerdr(['plugin', 'link', root, '--disabled']);
    const reparsed = pluginFor(herdrPlugins(), id);
    if (!reparsed || !summaryRecord(reparsed, expected.root, expected.source, expected.authority)) fail('Herdr registration changed before activation');
    if (enabled) {
        runHerdr(['plugin', 'enable', id]);
    }
    const final = pluginFor(herdrPlugins(), id);
    if (!final || !summaryRecord(final, expected.root, expected.source, expected.authority, enabled)) fail('Herdr registration changed after activation');
}
function restoreLocal(previous, id) {
    const errors = [];
    const unlink = runHerdrOptional(['plugin', 'unlink', id]); if (!unlink.ok && !/not (?:found|installed)|unknown plugin/i.test(`${unlink.stdout}${unlink.stderr}`)) errors.push(`unlink: ${unlink.stderr || unlink.stdout}`);
    if (previous) {
        if (!previous.plugin_root || !existsSync(previous.plugin_root)) errors.push('previous local root is missing');
        else {
            const link = runHerdrOptional(['plugin', 'link', previous.plugin_root, '--disabled']); if (!link.ok) errors.push(`link: ${link.stderr || link.stdout}`);
            if (previous.enabled === true) { const enable = runHerdrOptional(['plugin', 'enable', id]); if (!enable.ok) errors.push(`enable: ${enable.stderr || enable.stdout}`); }
        }
    }
    if (errors.length) fail(`rollback failed (${errors.join('; ')})`);
}
async function localMutate(root, yes, update) {
    const checked = checkPlugin(root); return withRegistryLock(checked.pluginId, async () => {
        const before = pluginFor(herdrPlugins(), checked.pluginId);
        const oldNpm = before && validNpmProvenance(before);
        if (!update && before) fail(`plugin already installed: ${checked.pluginId}`);
        if (update && (!before || before.source?.kind === 'github' || oldNpm || isNpmRoot(before))) fail('local update requires an existing local plugin');
        try {
            runHerdr(['plugin', 'link', checked.root, '--disabled']);
            const linked = pluginFor(herdrPlugins(), checked.pluginId);
            const expected = linked && pluginIdentity(linked);
            if (!linked || !expected || !summaryRecord(linked, checked.root, expected.source, expected.authority)) fail('Herdr did not register the local plugin disabled');
            process.stdout.write(`Herdr authority/source summary:\n${extensionSummary(linked, { kind: 'local' })}\nWARNING: code, builds, and actions run unsandboxed as the host user.\n`);
            if (!await confirm(yes, `${update ? 'Update' : 'Install'} ${checked.pluginId}?`)) { runHerdr(['plugin', 'unlink', checked.pluginId]); restoreLocal(before, checked.pluginId); process.stdout.write('cancelled; staged package unlinked\n'); return 0; }
            if (!expected) fail('missing local plugin activation identity');
            relinkAndVerify(checked.pluginId, checked.root, { root: expected.root, source: expected.source, authority: expected.authority }, !update || before.enabled === true);
            process.stdout.write(`${update ? 'updated' : 'installed'} ${checked.pluginId}\n`); return 0;
        } catch (error) { try { restoreLocal(before, checked.pluginId); } catch (rollback) { throw new Error(`${error instanceof Error ? error.message : String(error)}; ${rollback instanceof Error ? rollback.message : String(rollback)}`); } throw error; }
    });
}
async function npmMutate(spec, yes, update) {
    const packed = packNpm(spec); ensureManagedDirectory(extensionHome(), '$MUXR_HOME/extensions');
    const stageParent = mkdtempSync(join(extensionHome(), '.staging-')); const stage = join(stageParent, 'package');
    try {
        const checked = materialize(packed.files, stage, spec.name, spec.version); const id = checked.pluginId;
        return await withRegistryLock(id, async () => {
            const before = pluginFor(herdrPlugins(), id); const old = before && validNpmProvenance(before);
            if (!update && before) fail(`plugin already installed: ${id}`);
            if (update && (!before || !old || old.name !== spec.name)) fail('npm update requires an existing valid npm installation of the same package name');
            const extensionRoot = resolve(extensionHome());
            const target = join(extensionRoot, id);
            if (!parsePluginId(id).ok || relative(extensionRoot, target) !== id) fail('invalid materialization path: extension id must be one direct child');
            if (!before && existsSync(target)) fail(`plugin materialization already exists: ${id}`);
            const backupParent = mkdtempSync(join(extensionHome(), '.backup-'));
            let backupRoot, backupMeta, rootMoved = false, newRootInstalled = false, newRegistryLinked = false, committed = false;
            try {
                // Provenance is captured before any Herdr operation. The random
                // backup directory is private scratch, never a predictable target.
                backupMeta = backupProvenance(id, backupParent);
                if (before?.enabled === true) runHerdr(['plugin', 'disable', id]);
                if (before) runHerdr(['plugin', 'unlink', id]);
                if (existsSync(target)) { backupRoot = join(backupParent, 'root'); renameSync(target, backupRoot); rootMoved = true; }
                renameSync(stage, target); newRootInstalled = true;
                const finalRoot = realpathSync(target);
                atomicProvenance(id, { schemaVersion: 1, pluginId: id, root: finalRoot, name: spec.name, version: spec.version, integrity: packed.integrity });
                newRegistryLinked = true;
                runHerdr(['plugin', 'link', target, '--disabled']);
                const linked = pluginFor(herdrPlugins(), id); const expected = linked && pluginIdentity(linked);
                if (!linked || !expected || !summaryRecord(linked, finalRoot, expected.source, expected.authority)) fail('Herdr did not register the npm plugin disabled');
                process.stdout.write(`Herdr authority/source summary:\n${extensionSummary(linked, sourceFor(linked))}\nWARNING: code, builds, and actions run unsandboxed as the host user.\n`);
                const action = update ? 'Update' : 'Install';
                if (!await confirm(yes, `${action} ${id}?`)) fail('cancelled');
                const desiredEnabled = !update || before.enabled === true;
                relinkAndVerify(id, finalRoot, { root: expected.root, source: expected.source, authority: expected.authority }, desiredEnabled);
                committed = true;
                cleanupBackup(backupParent);
                process.stdout.write(`${update ? 'updated' : 'installed'} ${id} (${spec.name}@${spec.version})\n`); return 0;
            } catch (error) {
                if (committed) throw error;
                const rollback = [];
                try {
                    if (newRegistryLinked) {
                        const unlink = runHerdrOptional(['plugin', 'unlink', id]);
                        if (!unlink.ok && !/not (?:found|installed)|unknown plugin/i.test(`${unlink.stdout}${unlink.stderr}`)) rollback.push(`unlink: ${unlink.stderr || unlink.stdout}`);
                    }
                } catch (e) { rollback.push(String(e)); }
                // Before a swap the target is still the live old install. Never
                // remove it merely because an earlier Herdr phase failed.
                try { if (newRootInstalled && existsSync(target)) rmSync(target, { recursive: true, force: true }); } catch (e) { rollback.push(`materialization: ${e}`); }
                try {
                    removeProvenanceTemp(id);
                    if (newRootInstalled) removeProvenance(id);
                    if (rootMoved && backupRoot && existsSync(backupRoot)) renameSync(backupRoot, target);
                    if (backupMeta) restoreProvenance(id, backupMeta);
                } catch (e) { rollback.push(`provenance/root: ${e}`); }
                try { if (before) restoreLocal(before, id); } catch (e) { rollback.push(String(e)); }
                try { rmSync(backupParent, { recursive: true, force: true }); } catch (e) { rollback.push(`backup cleanup: ${e}`); }
                if (rollback.length) fail(`rollback failed (${rollback.join('; ')})`);
                if (error instanceof Error && error.message === 'cancelled') { process.stdout.write('cancelled; staged package and registration removed\n'); return 0; }
                throw error;
            }
        });
    } finally { rmSync(stageParent, { recursive: true, force: true }); }
}
async function gitInstall(github, yes) {
    const lockId = `git-${createHash('sha256').update(github.source).digest('hex').slice(0, 24)}`;
    return withRegistryLock(lockId, async () => {
        const before = herdrPlugins().some((plugin) => plugin.source?.kind === 'github' && plugin.source.owner === github.owner && plugin.source.repo === github.repo && plugin.source.subdir === github.subdir);
        // Herdr remains the Git parser, preview, and installer; muxr only serializes it.
        runHerdr(['plugin', 'install', github.source, ...(github.ref ? ['--ref', github.ref] : []), ...(yes ? ['--yes'] : [])]);
        process.stdout.write(`${before ? 'updated' : 'installed'} ${github.source}${github.ref ? `@${github.ref}` : ''}\n`); return 0;
    });
}

export async function listPlugins(args = []) {
    if (args.length) fail('muxr plugin list takes no arguments');
    for (const plugin of herdrPlugins()) {
        const version = plugin.version ?? '0.0.0';
        const enabled = plugin.enabled ? 'enabled' : 'disabled';
        process.stdout.write(`${plugin.plugin_id}\t${version}\t${enabled}\t${JSON.stringify(sourceFor(plugin))}\t${plugin.plugin_root ?? ''}\n`);
    }
    return 0;
}

export async function removePlugin(args = []) {
    const { spec: requested, yes } = requireArgs(args, 'remove');
    const parsedId = parsePluginId(requested);
    if (!parsedId.ok) fail(parsedId.reason);
    const installed = herdrPlugins();
    const localId = `local.${requested}`.slice(0, 64);
    const id = pluginFor(installed, requested)
        ? requested
        : (pluginFor(installed, localId) ? localId : requested);
    return withRegistryLock(id, async () => {
        const plugin = pluginFor(herdrPlugins(), id); if (!plugin) fail(`plugin is not installed: ${requested}`); const npm = validNpmProvenance(plugin); const action = npm ? 'unlink then remove managed npm materialization' : plugin.source?.kind === 'github' ? 'uninstall' : 'unlink';
        if (!await confirm(yes, `Remove ${id} (${action})?`)) return 0;
        if (npm) { runHerdr(['plugin', 'unlink', id]); const root = validRoot(plugin.plugin_root); if (!root || !isNpmRoot(plugin)) fail('refusing to remove an untrusted npm materialization path'); rmSync(root, { recursive: true, force: true }); removeProvenance(id); }
        else runHerdr(['plugin', action === 'uninstall' ? 'uninstall' : 'unlink', id]);
        process.stdout.write(`removed ${id}\n`); return 0;
    });
}

async function mutatePlugin(command, args = []) {
    const { spec, yes } = requireArgs(args, command); const npm = parseNpmSpec(spec); if (npm) return npmMutate(npm, yes, command === 'update');
    if (existsSync(resolve(spec))) return localMutate(resolve(spec), yes, command === 'update');
    const github = parseGithubSpec(spec); if (github) return gitInstall(github, yes);
    fail('package spec must be a local path, owner/repo[/subdir][@ref], or npm:<name>@<exact-version>');
}

export async function installPlugin(args = []) {
    return mutatePlugin('install', args);
}

export async function updatePlugin(args = []) {
    return mutatePlugin('update', args);
}
