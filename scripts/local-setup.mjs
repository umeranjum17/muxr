import { createHash, randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import QRCode from 'qrcode';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { homedir, hostname, networkInterfaces, platform as hostPlatform, tmpdir, userInfo } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const MIN_HERDR = [0, 8, 0];
const DURABLE_GRANT_EXPIRES_AT = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
const BROWSER_GRANT_TTL_MS = 8 * 60 * 60_000;
const HERDR_INSTALL_URL = 'https://herdr.dev/install.sh';
const HERDR_INSTALL_HINT = 'install herdr >= 0.8.0 from https://herdr.dev';
const START = '<!-- muxr:herdr-skill:start -->';
const END = '<!-- muxr:herdr-skill:end -->';
const PACKAGED_CONTROL_URL = '__MUXR_PACKAGED_CONTROL_URL__';
// Only tools with a stable instruction-file contract belong here. Lifecycle
// integrations are discovered dynamically from `herdr integration status`.
const TARGETS = [
    ['pi', ['pi'], ['.pi', 'agent', 'AGENTS.md']],
].map(([id, commands, instructionParts]) => ({ id, commands, instructionParts }));
const INTEGRATION_COMMANDS = {
    'antigravity-cli': ['antigravity', 'antigravity-cli'],
    qodercli: ['qoder', 'qodercli'],
    mastracode: ['mastra', 'mastracode'],
};

const print = (text = '') => process.stdout.write(`${text}\n`);
const error = (text) => process.stderr.write(`${text}\n`);
function env(name) {
    return process.env[name]?.trim() || undefined;
}

const home = () => process.env.HOME?.trim() || homedir();
const defaultStateDir = () => join(home(), '.muxr');
const stateDir = () => env('MUXR_HOME') || defaultStateDir();
const manifestPath = () => join(stateDir(), 'setup-manifest.json');
const authPath = () => join(stateDir(), 'auth.json');
const bundledPluginPath = (name) => existsSync(fileURLToPath(new URL(`./plugins/${name}/herdr-plugin.toml`, import.meta.url)))
    ? fileURLToPath(new URL(`./plugins/${name}`, import.meta.url))
    : fileURLToPath(new URL(`../plugins/${name}`, import.meta.url));
const pluginAuthoringSkillSource = () => existsSync(fileURLToPath(new URL('./skills/muxr-plugin-authoring/SKILL.md', import.meta.url)))
    ? fileURLToPath(new URL('./skills/muxr-plugin-authoring/SKILL.md', import.meta.url))
    : fileURLToPath(new URL('../skills/muxr-plugin-authoring/SKILL.md', import.meta.url));
function bundledPlugins() {
    const packaged = fileURLToPath(new URL('./plugins', import.meta.url));
    const fromRepo = fileURLToPath(new URL('../plugins', import.meta.url));
    const dir = existsSync(join(packaged, 'control', 'herdr-plugin.toml')) ? packaged : fromRepo;
    return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'herdr-plugin.toml')))
        .map((entry) => {
            const id = readFileSync(join(dir, entry.name, 'herdr-plugin.toml'), 'utf8').match(/^id\s*=\s*"([^"]+)"/m)?.[1];
            if (id === undefined) throw new Error(`plugins/${entry.name}/herdr-plugin.toml is missing id`);
            return { id, name: entry.name, enabledByDefault: !['voice-gemini', 'voice-openai'].includes(entry.name) };
        })
        .sort((left, right) => left.name.localeCompare(right.name));
}
const platform = () => env('MUXR_PLATFORM') || hostPlatform();
const hash = (text) => createHash('sha256').update(text).digest('hex');
const timestamp = () => new Date().toISOString().replaceAll(/[:.]/g, '-');
const base64 = (bytes) => Buffer.from(bytes).toString('base64');
const cryptoEntry = existsSync(fileURLToPath(new URL('./crypto.js', import.meta.url)))
    ? new URL('./crypto.js', import.meta.url)
    : new URL('../packages/crypto/dist/index.js', import.meta.url);
const {
    PAIRING_CODE_ALPHABET,
    createDeviceGrant,
    deriveV2Key,
    formatPairingCode,
    newV2ReplayTracker,
    openV2,
    pairingCodeHash,
    sealPairingCodePayload,
} = await import(cryptoEntry.href);

function newPairingCode() {
    let code = '';
    const ceiling = Math.floor(256 / PAIRING_CODE_ALPHABET.length) * PAIRING_CODE_ALPHABET.length;
    while (code.length < 10) {
        for (const value of randomBytes(16)) {
            if (value < ceiling) code += PAIRING_CODE_ALPHABET[value % PAIRING_CODE_ALPHABET.length];
            if (code.length === 10) break;
        }
    }
    return formatPairingCode(code);
}

function ensurePrivateDir(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
}

function atomicWrite(path, text, mode = 0o600) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
    try {
        writeFileSync(temporary, text, { mode, flag: 'wx' });
        chmodSync(temporary, mode);
        renameSync(temporary, path);
    } finally {
        rmSync(temporary, { force: true });
    }
}

function loadManifest() {
    try {
        const parsed = JSON.parse(readFileSync(manifestPath(), 'utf8'));
        if (parsed.version === 1 && parsed.entries && parsed.herdrInstalled) return parsed;
    } catch {}
    return { version: 1, entries: {}, herdrInstalled: [] };
}

function saveManifest(manifest, dryRun) {
    if (dryRun) return;
    ensurePrivateDir(stateDir());
    atomicWrite(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
}

function backup(path) {
    const destination = `${path}.muxr-backup-${timestamp()}`;
    writeFileSync(destination, readFileSync(path), { mode: statSync(path).mode & 0o777 });
    return destination;
}

function realpathOrUndefined(path) {
    try { return realpathSync(path); } catch { return undefined; }
}

function executable(command) {
    if (command.includes('/')) return existsSync(command) ? command : undefined;
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
        if (!directory) continue;
        const candidate = join(directory, command);
        try {
            if (statSync(candidate).isFile() && (statSync(candidate).mode & 0o111) !== 0) return candidate;
        } catch {}
    }
    return undefined;
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: 'utf8', ...options });
    return {
        ok: result.status === 0,
        status: result.status ?? 1,
        stdout: result.stdout?.trim() ?? '',
        stderr: result.stderr?.trim() ?? '',
    };
}

function herdrBin() {
    return process.env.HERDR_BIN?.trim() || executable('herdr');
}

function parseVersion(text) {
    const match = text.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
    return match ? match.slice(1).map(Number) : undefined;
}

function versionIsCompatible(version) {
    for (let index = 0; index < MIN_HERDR.length; index += 1) {
        if (version[index] > MIN_HERDR[index]) return true;
        if (version[index] < MIN_HERDR[index]) return false;
    }
    return true;
}

function parseIntegrationStatus(text) {
    const statuses = new Map();
    for (const line of text.split('\n')) {
        const match = line.match(/^([^:]+):\s+([^\s(]+(?:\s+[^\s(]+)*)/);
        if (match) statuses.set(match[1], match[2].trim());
    }
    return statuses;
}

function detectedTargets(all = false) {
    return TARGETS.filter((target) => all || target.commands.some(executable));
}

function detectedLifecycleTargets(statuses, all = false) {
    return [...statuses.entries()].filter(([id, status]) => {
        if (all) return true;
        if (status === 'current') return true;
        return (INTEGRATION_COMMANDS[id] ?? [id]).some(executable);
    });
}

function managedBlock(skillPath, pluginSkillPath) {
    return `${START}\n## Herdr\nWhen the user explicitly asks to use Herdr, read \`${skillPath}\` before acting.\n\n## muxr plugins\nWhen the user asks to create, modify, install, or replace a muxr plugin, read \`${pluginSkillPath}\` before acting.\n${END}`;
}

function blockFrom(text) {
    const start = text.indexOf(START);
    const end = text.indexOf(END, start < 0 ? 0 : start);
    return start >= 0 && end >= 0 ? text.slice(start, end + END.length) : undefined;
}

function writeOwned(path, content, manifest, { dryRun, force, mode = 0o600 }) {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    const entry = manifest.entries[path];
    if (entry && entry.kind !== 'owned') throw new Error(`manifest kind mismatch for ${path}`);
    if (entry && (current === undefined || hash(current) !== entry.hash) && !force) {
        throw new Error(`drift: ${path} was edited or removed; rerun with --force to replace it`);
    }
    if (current === content) {
        if (!entry && !dryRun) manifest.entries[path] = { kind: 'owned', hash: hash(content) };
        return false;
    }
    print(`  ${dryRun ? 'would write' : 'write'} ${path}`);
    if (dryRun) return true;
    let backupPath = entry?.backup;
    if (current !== undefined && backupPath === undefined) backupPath = backup(path);
    atomicWrite(path, content, mode);
    manifest.entries[path] = { kind: 'owned', hash: hash(content), ...(backupPath ? { backup: backupPath } : {}) };
    return true;
}

function writeBlock(path, block, manifest, { dryRun, force }) {
    const fileExisted = existsSync(path);
    const current = fileExisted ? readFileSync(path, 'utf8') : '';
    const existingBlock = blockFrom(current);
    const entry = manifest.entries[path];
    if (entry && entry.kind !== 'block') throw new Error(`manifest kind mismatch for ${path}`);
    if (entry && (existingBlock === undefined || hash(existingBlock) !== entry.hash) && !force) {
        throw new Error(`drift: managed block in ${path} was edited or removed; rerun with --force to replace it`);
    }
    if (!entry && existingBlock !== undefined && existingBlock !== block && !force) {
        throw new Error(`drift: unmanaged muxr markers already exist in ${path}; rerun with --force to adopt them`);
    }
    if (existingBlock === block) {
        if (!entry && !dryRun) manifest.entries[path] = { kind: 'block', hash: hash(block), created: false };
        return false;
    }
    const next = existingBlock === undefined
        ? `${current.replace(/\s*$/, '')}${current.trim() ? '\n\n' : ''}${block}\n`
        : current.replace(existingBlock, block);
    print(`  ${dryRun ? 'would update' : 'update'} managed block in ${path}`);
    if (dryRun) return true;
    let backupPath = entry?.backup;
    if (existsSync(path) && backupPath === undefined) backupPath = backup(path);
    atomicWrite(path, next, fileExisted ? statSync(path).mode & 0o777 : 0o600);
    manifest.entries[path] = {
        kind: 'block',
        hash: hash(block),
        created: entry?.created ?? !fileExisted,
        ...(backupPath ? { backup: backupPath } : {}),
    };
    return true;
}

function removeManaged(path, entry, manifest, { dryRun, force }) {
    if (!existsSync(path)) {
        delete manifest.entries[path];
        return false;
    }
    const current = readFileSync(path, 'utf8');
    if (entry.kind === 'owned') {
        if (hash(current) !== entry.hash && !force) throw new Error(`drift: ${path} was edited; refusing managed uninstall`);
        print(`  ${dryRun ? 'would remove' : 'remove'} ${path}`);
        if (!dryRun) rmSync(path);
    } else {
        const block = blockFrom(current);
        if (block === undefined) {
            if (!force) throw new Error(`drift: managed block markers are missing from ${path}`);
        } else {
            if (hash(block) !== entry.hash && !force) throw new Error(`drift: managed block in ${path} was edited; refusing uninstall`);
            const next = current.replace(block, '').replace(/\n{3,}/g, '\n\n').trimEnd();
            print(`  ${dryRun ? 'would remove' : 'remove'} managed block from ${path}`);
            if (!dryRun) {
                if (entry.created && !next) rmSync(path);
                else atomicWrite(path, next ? `${next}\n` : '', statSync(path).mode & 0o777);
            }
        }
    }
    if (!dryRun) delete manifest.entries[path];
    return true;
}

async function askVisible(question) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(question, (answer) => {
        rl.close();
        resolve(/^y(?:es)?$/i.test(answer.trim()));
    }));
}

function runHerdrInstaller() {
    const localInstaller = process.env.MUXR_HERDR_INSTALLER?.trim();
    if (localInstaller) {
        const info = lstatSync(localInstaller);
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0) {
            throw new Error('MUXR_HERDR_INSTALLER must be an executable regular file');
        }
        print(`  run reviewed local Herdr installer: ${localInstaller}`);
        const installed = spawnSync(localInstaller, [], { stdio: 'inherit' });
        if (installed.status !== 0) throw new Error('local Herdr installation failed');
        return;
    }

    const scratch = mkdtempSync(join(tmpdir(), 'muxr-herdr-install-'));
    const installer = join(scratch, 'install.sh');
    try {
        print(`  download Herdr installer for this approved run: ${HERDR_INSTALL_URL}`);
        const downloaded = spawnSync('curl', ['-fsSL', HERDR_INSTALL_URL, '-o', installer], { stdio: 'inherit' });
        if (downloaded.status !== 0) throw new Error('Herdr installer download failed');
        const installed = spawnSync('sh', [installer], { stdio: 'inherit' });
        if (installed.status !== 0) throw new Error('Herdr installation failed');
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

async function ensureHerdr({ dryRun, noInstall, installRequested }) {
    let binary = herdrBin();
    if (!binary) {
        if (noInstall && installRequested) throw new Error('choose only one of --install-herdr or --no-install-herdr');
        if (noInstall) throw new Error(`herdr is missing; ${HERDR_INSTALL_HINT}`);
        let approved = installRequested;
        if (!approved) {
            if (dryRun) {
                print('  would ask before installing Herdr [y/N] (default No)');
                return undefined;
            }
            if (!process.stdin.isTTY || !process.stdout.isTTY) {
                throw new Error(`herdr is missing; ${HERDR_INSTALL_HINT}, or rerun with --install-herdr`);
            }
            approved = await askVisible(`Herdr is missing. Download and run ${HERDR_INSTALL_URL}? [y/N] `);
        }
        if (!approved) throw new Error(`Herdr installation declined; ${HERDR_INSTALL_HINT}`);
        if (dryRun) {
            print(`  would install Herdr from ${process.env.MUXR_HERDR_INSTALLER?.trim() || HERDR_INSTALL_URL}`);
            return undefined;
        }
        runHerdrInstaller();
        binary = herdrBin();
        if (!binary) throw new Error('herdr installed but is not on PATH; restart the shell and rerun setup');
    }
    const versionResult = run(binary, ['--version']);
    const version = parseVersion(versionResult.stdout);
    if (!versionResult.ok || !version || !versionIsCompatible(version)) {
        throw new Error(`herdr >= 0.8.0 is required; found ${versionResult.stdout || 'an unreadable version'}. Run \`herdr update\` after reviewing the upgrade.`);
    }
    print(`  ✓ herdr ${version.join('.')} (adopted; config and sessions unchanged)`);
    return binary;
}

async function ensureBundledPlugins(binary, dryRun) {
    const pluginList = run(binary, ['plugin', 'list', '--json']);
    if (!pluginList.ok) throw new Error(pluginList.stderr || pluginList.stdout || 'failed to list Herdr plugins');
    let installed;
    try {
        const parsed = JSON.parse(pluginList.stdout);
        installed = parsed.result?.plugins ?? parsed.plugins;
    } catch {
        throw new Error('Herdr returned an invalid plugin list');
    }
    if (!Array.isArray(installed) || installed.some((plugin) =>
        typeof plugin?.plugin_id !== 'string' || plugin.plugin_id === ''
        || typeof plugin.plugin_root !== 'string' || plugin.plugin_root === ''
        || typeof plugin.enabled !== 'boolean')) {
        throw new Error('Herdr returned an invalid plugin list');
    }
    const bundled = bundledPlugins();
    const bundledIds = new Set(bundled.map((plugin) => plugin.id));
    const bundledRoot = realpathSync(dirname(bundledPluginPath(bundled[0].name)));
    // Retired bundled IDs merged into a successor. Match both the explicit ID
    // and its package-owned root so a local plugin reusing an old ID survives.
    const retiredBundled = new Map([
        ['muxr.file-viewer', { successor: 'muxr.code', directory: 'file-viewer' }],
        ['muxr.changes', { successor: 'muxr.code', directory: 'changes' }],
        ['muxr.git-history', { successor: 'muxr.code', directory: 'git-history' }],
        ['muxr.runbook', { successor: 'muxr.code', directory: 'runbook' }],
        ['muxr.usage-status', { successor: 'muxr.status', directory: 'usage-status' }],
        ['muxr.vitals', { successor: 'muxr.status', directory: 'vitals' }],
        ['muxr.ports', { successor: 'muxr.servers', directory: 'ports' }],
        ['muxr.run-server', { successor: 'muxr.servers', directory: 'run-server' }],
    ]);
    for (const current of installed) {
        const retired = retiredBundled.get(current.plugin_id);
        if (retired === undefined || !bundledIds.has(retired.successor)
            || typeof current.plugin_root !== 'string'
            || resolve(current.plugin_root) !== resolve(bundledRoot, retired.directory)) continue;
        if (dryRun) { print(`  would unlink retired bundled plugin ${current.plugin_id}`); continue; }
        const unlinked = run(binary, ['plugin', 'unlink', current.plugin_id]);
        print(`  ${unlinked.ok ? '✓' : 'warn:'} unlinked retired bundled plugin ${current.plugin_id}`);
    }
    for (const { id, name, enabledByDefault } of bundled) {
        const current = installed.find((plugin) => plugin.plugin_id === id);
        const expected = realpathSync(bundledPluginPath(name));
        if (current && realpathOrUndefined(current.plugin_root) === expected) {
            print(`  ✓ ${id} Herdr plugin ready${current.enabled === true ? '' : ' (disabled)'}`);
            continue;
        }
        const enabled = current ? current.enabled === true : enabledByDefault;
        if (dryRun) {
            print(`  would link ${id} from ${expected} (${enabled ? 'enabled' : 'disabled'})`);
            continue;
        }
        const linked = run(binary, ['plugin', 'link', expected, enabled ? '--enabled' : '--disabled']);
        if (!linked.ok) throw new Error(linked.stderr || linked.stdout || `failed to link ${id}`);
        print(`  ✓ ${id} Herdr plugin ${current ? 'updated' : 'installed'}${enabled ? '' : ' (disabled)'}`);
    }
}

/** Absolute paths referenced by a service file's exec line that no longer exist. */
function staleUnitPaths(unitPath) {
    const content = readFileSync(unitPath, 'utf8');
    // systemd allows -@!:+ prefixes on the executable; strip them before
    // tokenizing or the prefix fuses with the quoted path into one token.
    const execStart = content.match(/^ExecStart=(.*)$/m)?.[1]?.replace(/^[-@!:+]+/, '');
    const tokens = execStart !== undefined
        ? [...execStart.matchAll(/"([^"]+)"|(\S+)/g)].map((match) => match[1] ?? match[2])
        : [...(content.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '')
            .matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1]);
    return tokens
        // Undo systemd %% escaping so a path containing % is not a false FAIL.
        .map((token) => token.replaceAll('%%', '%'))
        .filter((token) => token.startsWith('/') && !existsSync(token));
}

function herdrServiceUnitPaths() {
    if (platform() === 'linux') {
        const unit = join(home(), '.config', 'systemd', 'user', 'herdr-server.service');
        return existsSync(unit) ? [unit] : [];
    }
    if (platform() === 'darwin') {
        // No known label: adopt any herdr LaunchAgent the user already has.
        const dir = join(home(), 'Library', 'LaunchAgents');
        try {
            return readdirSync(dir)
                .filter((name) => /herdr/i.test(name) && name.endsWith('.plist'))
                .map((name) => join(dir, name));
        } catch { return []; }
    }
    return [];
}

/**
 * A system upgrade can move the herdr binary while the service file pins the
 * old absolute path — the 203/EXEC boot-loop landmine. Rewrite only a
 * genuinely stale pinned path; never touch a unit whose exec still resolves.
 */
function repairHerdrServiceUnits(binary, dryRun) {
    for (const unitPath of herdrServiceUnitPaths()) {
        const pinned = staleUnitPaths(unitPath).find((path) => basename(path) === 'herdr');
        if (pinned === undefined || pinned === binary) continue;
        if (dryRun) {
            print(`  would repair ${unitPath}: pinned herdr ${pinned} no longer exists`);
            continue;
        }
        const content = readFileSync(unitPath, 'utf8');
        const execLine = content.match(/^ExecStart=.*$/m)?.[0]?.trim() ?? pinned;
        const updated = content.includes('ExecStart=')
            ? content.replace(/^ExecStart=.*$/m, (line) => line.replaceAll(pinned, binary))
            : content.replace(`<string>${pinned}</string>`, `<string>${xml(binary)}</string>`);
        // muxr does not own this file: back it up, write atomically, and print
        // the old exec line so the change is recoverable by hand.
        const backupPath = backup(unitPath);
        atomicWrite(unitPath, updated, statSync(unitPath).mode & 0o777);
        print(`  repaired ${unitPath}: was \`${execLine}\`, now runs ${binary} (backup: ${backupPath})`);
        if (env('MUXR_NO_SERVICE_COMMANDS') !== '1' && platform() === 'linux') run('systemctl', ['--user', 'daemon-reload']);
    }
}

/** Start herdr through its own service manager so it stays managed. */
function startHerdrServiceUnits(unitPaths) {
    for (const unitPath of unitPaths) {
        if (platform() === 'darwin') {
            const service = `gui/${process.getuid()}/${basename(unitPath, '.plist')}`;
            const loaded = run('launchctl', ['print', service]);
            if (loaded.ok) run('launchctl', ['kickstart', '-k', service]);
            else run('launchctl', ['bootstrap', `gui/${process.getuid()}`, unitPath]);
        } else {
            run('systemctl', ['--user', 'start', basename(unitPath)]);
        }
    }
}

/**
 * Make sure the herdr server is running: repair a stale service path first,
 * then start it. Idempotent — host-up calls this on every service start.
 */
export async function ensureHerdrServer(binary = herdrBin(), dryRun = false) {
    if (!binary) throw new Error(`herdr is missing; ${HERDR_INSTALL_HINT}`);
    repairHerdrServiceUnits(binary, dryRun);
    let status = run(binary, ['status']);
    if (!status.ok) {
        if (dryRun) {
            print('  would start the herdr server');
        } else {
            const units = env('MUXR_NO_SERVICE_COMMANDS') === '1' ? [] : herdrServiceUnitPaths();
            let logPath;
            if (units.length > 0) {
                // Start the managed unit, not a stray process: a direct spawn
                // lands in muxr.service's cgroup (`muxr daemon stop` kills
                // herdr) and races the systemd-started server at boot.
                startHerdrServiceUnits(units);
            } else {
                logPath = join(stateDir(), 'logs', 'herdr.log');
                ensurePrivateDir(dirname(logPath));
                const out = openSync(logPath, 'a', 0o600);
                const server = spawn(binary, ['server'], { detached: true, stdio: ['ignore', out, out] });
                server.unref();
            }
            for (let attempt = 0; attempt < 30 && !status.ok; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 300));
                status = run(binary, ['status']);
            }
            if (!status.ok) {
                throw new Error(units.length > 0
                    ? `herdr server did not start; check \`journalctl --user -u ${units.map((unit) => basename(unit)).join(' ')}\``
                    : `herdr server did not start; see ${logPath}`);
            }
        }
    }
    print(`  ✓ herdr server ${dryRun && !status.ok ? 'would be started' : 'ready'}`);
    return binary;
}

async function bootstrapHerdr(args) {
    const dryRun = args.includes('--dry-run');
    const binary = await ensureHerdr({
        dryRun,
        noInstall: args.includes('--no-install-herdr'),
        installRequested: args.includes('--install-herdr'),
    });
    if (!binary) return undefined;
    await ensureHerdrServer(binary, dryRun);
    await ensureBundledPlugins(binary, dryRun);
    return binary;
}

export async function runBootstrap(args = []) {
    try {
        const binary = await bootstrapHerdr(args);
        return binary || args.includes('--dry-run') ? 0 : 1;
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}

export async function runLocalPrerequisites(args = []) {
    try {
        const binary = await bootstrapHerdr(args);
        if (!binary) return args.includes('--dry-run') ? 0 : 1;
        if (args.includes('--no-integrations')) {
            print('  coding-agent integrations left unchanged');
            return 0;
        }
        const integrationArgs = ['sync', ...(args.includes('--dry-run') ? ['--dry-run'] : []), ...(args.includes('--force') ? ['--force'] : [])];
        if (args.includes('--all')) integrationArgs.push('--all');
        if (args.includes('--no-agent-config')) integrationArgs.push('--no-agent-config');
        return await runIntegrations(integrationArgs);
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}

function enrollmentPayload(link) {
    try {
        const parsed = new URL(link.trim());
        if (parsed.protocol !== 'muxr:' || parsed.hostname !== 'enroll') throw new Error('scheme');
        const compact = parsed.searchParams.get('payload');
        const payload = compact === null ? undefined : JSON.parse(Buffer.from(compact, 'base64url').toString('utf8'));
        const relay = publicRelayUrl(payload?.relay);
        if (payload?.v !== 1 || typeof payload?.id !== 'string' || typeof payload?.claim !== 'string'
            || relay === undefined || !relay.startsWith('wss://') || typeof payload?.expires === 'number' && payload.expires <= Date.now()) throw new Error('shape');
        return { id: payload.id, claim: payload.claim, relay };
    } catch { throw new Error('enrollment must be the muxr://enroll string created on the relay server'); }
}

export async function sharedMachineCount() {
    const state = readSelfhostState();
    if (state?.relayRole !== 'shared' || typeof state.mintSecret !== 'string') return 0;
    const listed = await api(selfhostControlBase(state), '/v1/selfhost/machines', { headers: { authorization: `Bearer ${state.mintSecret}` } });
    if (!listed.response.ok || !Array.isArray(listed.body.machines)) throw new Error(listed.body.error || 'could not verify enrolled machines');
    return listed.body.machines.filter((machine) => machine.revoked !== true).length;
}

export async function runMachines(command = 'list', args = []) {
    try {
        const state = readSelfhostState();
        if (state?.relayLocation === 'remote' || typeof state?.mintSecret !== 'string') throw new Error('machine management runs on the shared relay server');
        if (!(await selfhostRelayHealthy(state))) throw new Error('shared relay service is not healthy; choose Restart muxr, then try again');
        const base = selfhostControlBase(state);
        const headers = { authorization: `Bearer ${state.mintSecret}` };
        if (command === 'enroll') {
            if (state.connectionMode === 'cloudflare' && !cloudflaredAlive(state.ingress)) throw new Error('the Cloudflare tunnel is not running; restore the shared relay before creating enrollment');
            if (!(await selfhostRelayHealthy(state))) throw new Error('the shared relay is not healthy; run `muxr doctor` first');
            const relayUrl = publicRelayUrl(state.relayUrl);
            if (relayUrl === undefined || !relayUrl.startsWith('wss://')) throw new Error('shared relay enrollment requires a public wss:// relay URL');
            const created = await api(base, '/v1/selfhost/enrollments', {
                method: 'POST', headers,
                body: JSON.stringify({ relay_url: relayUrl, ...(state.webEnabled ? { web_url: relayUrl.replace(/^wss/, 'https') } : {}) }),
            });
            if (!created.response.ok) throw new Error(created.body.error || 'could not create enrollment');
            const payload = Buffer.from(JSON.stringify({ v: 1, id: created.body.enrollment_id, claim: created.body.claim,
                relay: created.body.relay_url, expires: Date.now() + Number(created.body.expires_in ?? 300) * 1000,
                ...(typeof created.body.web_url === 'string' ? { web: created.body.web_url } : {}) })).toString('base64url');
            const link = `muxr://enroll?payload=${payload}`;
            print('');
            if (process.stdout.isTTY) print(await QRCode.toString(link, { type: 'terminal', small: true }));
            print('Machine enrollment string (single-use, expires in five minutes):');
            print(link);
            const path = join(stateDir(), 'enrollment-link.txt');
            writeFileSync(path, `${link}\n`, { mode: 0o600 });
            print(`  saved exact enrollment string to ${path}`);
            return 0;
        }
        const listed = await api(base, '/v1/selfhost/machines', { headers });
        if (!listed.response.ok || !Array.isArray(listed.body.machines)) throw new Error(listed.body.error || 'could not list enrolled machines');
        const machines = listed.body.machines;
        if (command === 'list') {
            if (machines.length === 0) print('No enrolled machines.');
            else machines.forEach((machine, index) => print(`  ${index + 1}. ${machine.name || 'agent machine'} — enrolled ${new Date(machine.createdAt).toLocaleDateString()} · ${machine.revoked ? 'revoked; select it again to retry cleanup' : machine.expired ? 'credential expired' : `credential expires ${new Date(machine.expiresAt).toLocaleDateString()}`}`));
            return 0;
        }
        if (command !== 'revoke') throw new Error('usage: muxr machines enroll | list | revoke <number|name>');
        const reference = args.join(' ').trim();
        const position = /^\d+$/.test(reference) ? Number(reference) - 1 : -1;
        const named = machines.filter((machine) => machine.name?.toLowerCase() === reference.toLowerCase());
        const target = position >= 0 ? machines[position] : named.length === 1 ? named[0] : undefined;
        if (target === undefined) throw new Error(named.length > 1 ? 'machine name is ambiguous; use its list number' : 'machine not found');
        const revoked = await api(base, `/v1/selfhost/machines/${encodeURIComponent(target.slug)}`, { method: 'DELETE', headers });
        if (!revoked.response.ok) throw new Error(revoked.body.error || 'machine revocation failed');
        print(`  ✓ revoked ${target.name || 'agent machine'} and disconnected its devices`);
        return 0;
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}

export async function runRemoteConnect(args = []) {
    try {
        if (args.includes('--resume')) return await resumeRemoteConnect(args);
        const raw = flagValue(args, '--enrollment') ?? args.find((arg) => !arg.startsWith('--'));
        if (!raw) throw new Error('paste the enrollment with `muxr connect --enrollment <muxr://enroll?...>`');
        const enrollment = enrollmentPayload(raw);
        const existing = readSelfhostState();
        if (existing !== undefined && !args.includes('--force')) throw new Error('this machine already has muxr state; rerun interactive `muxr` to review replacing it');
        ensurePrivateDir(stateDir());
        const reuseIdentity = existing?.relayLocation === 'remote' && publicRelayUrl(existing.relayUrl) === enrollment.relay;
        const identity = machineIdentity(reuseIdentity ? existing : undefined);
        const message = Buffer.from(`muxr-enroll-v1\n${enrollment.id}\n${enrollment.relay}\n${identity.crypto.signingPublicKey}`, 'utf8');
        const proof = Buffer.from(nacl.sign.detached(message, Buffer.from(identity.crypto.signingSecretKey, 'base64'))).toString('base64');
        const enrollmentBase = env('MUXR_REMOTE_CONTROL_BASE')?.replace(/\/$/, '') ?? enrollment.relay.replace(/^wss:/, 'https:');
        const claimed = await api(enrollmentBase, `/v1/selfhost/enrollments/${encodeURIComponent(enrollment.id)}/claim`, {
            method: 'POST',
            body: JSON.stringify({ claim: enrollment.claim, relay_url: enrollment.relay,
                signing_public_key: identity.crypto.signingPublicKey, proof, name: identity.name ?? hostname() }),
        });
        if (!claimed.response.ok) throw new Error(claimed.body.error || 'machine enrollment failed');
        const expectedSlug = `machine-${createHash('sha256').update('muxr-machine-v1\0').update(Buffer.from(identity.crypto.signingPublicKey, 'base64')).digest('hex').slice(0, 32)}`;
        if (claimed.body.machine_slug !== expectedSlug || typeof claimed.body.machine_credential !== 'string'
            || typeof claimed.body.credential_expires_at !== 'string' || Date.parse(claimed.body.credential_expires_at) <= Date.now()) {
            throw new Error('relay returned an invalid machine identity');
        }
        identity.id = expectedSlug;
        const state = {
            version: 1,
            relayLocation: 'remote',
            relayUrl: enrollment.relay,
            connectionMode: 'remote',
            machineCredential: claimed.body.machine_credential,
            credentialExpiresAt: claimed.body.credential_expires_at,
            webEnabled: typeof claimed.body.web_url === 'string',
            webOrigin: typeof claimed.body.web_url === 'string' ? claimed.body.web_url : undefined,
            machine: identity,
        };
        const pendingPath = join(stateDir(), 'selfhost.pending.json');
        writeFileSync(pendingPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
        if (existing !== undefined) {
            writeFileSync(join(stateDir(), 'selfhost.previous.json'), `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
            try {
                if (existing.relayLocation !== 'remote') cleanupManagedIngress(existing);
                if (daemonIsRunning() && (await runDaemon(['stop'])) !== 0) throw new Error('could not stop the existing muxr service');
                await stopOwnedSelfhostRelay();
            } catch (cause) {
                writeSelfhostState(state);
                rmSync(pendingPath, { force: true });
                try { await startMuxrDaemon('selfhost', args, true); } catch { /* doctor reports the remaining service issue */ }
                throw new Error(`enrollment completed and the scoped credential was saved, but replacing the previous runtime failed: ${cause instanceof Error ? cause.message : String(cause)}; run \`muxr doctor\``);
            }
        }
        writeSelfhostState(state);
        rmSync(pendingPath, { force: true });
        try { await startMuxrDaemon('selfhost', args, true); }
        catch (cause) {
            throw new Error(`enrollment completed and the scoped credential was saved, but the local service did not start: ${cause instanceof Error ? cause.message : String(cause)}; choose Restart muxr after fixing the reported service issue`);
        }
        for (let attempt = 0; attempt < 40 && !(await remoteHostOnline(state)); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!(await remoteHostOnline(state))) throw new Error('the scoped credential was saved, but the local host did not authenticate with the shared relay; run `muxr doctor`');
        rmSync(join(stateDir(), 'selfhost.previous.json'), { force: true });
        print(`  ✓ connected this machine to ${enrollment.relay}`);
        print(`  ✓ machine credential expires ${new Date(state.credentialExpiresAt).toLocaleDateString()}`);
        if (args.includes('--no-pair')) return 0;
        const kind = args.includes('--pair-browser') ? 'browser' : 'native';
        if ((kind === 'browser' || args.includes('--pair-both')) && !state.webEnabled) throw new Error('this shared relay does not host the browser client; pair the native app instead');
        const paired = await withSelfhostRotationLock(() => runSelfhostPair(state, kind));
        if (paired !== 0) return paired;
        return args.includes('--pair-both') ? runPair(['--browser']) : 0;
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}

export async function runIntegrations(args = []) {
    const dryRun = args.includes('--dry-run');
    const force = args.includes('--force');
    const all = args.includes('--all');
    const noAgentConfig = args.includes('--no-agent-config');
    const uninstall = args[0] === 'uninstall';
    const binary = herdrBin();
    if (!binary && !uninstall) {
        error(`herdr is missing; ${HERDR_INSTALL_HINT}`);
        return 1;
    }
    const manifest = loadManifest();
    try {
        if (uninstall) {
            let incomplete = false;
            print('muxr managed integration uninstall:');
            for (const [path, entry] of Object.entries(manifest.entries)) {
                if (entry.scope === 'daemon') continue;
                removeManaged(path, entry, manifest, { dryRun, force });
            }
            saveManifest(manifest, dryRun);
            for (const target of [...manifest.herdrInstalled]) {
                if (!binary) {
                    print(`  warn: herdr is missing; lifecycle integration ${target} remains installed`);
                    incomplete = true;
                    continue;
                }
                print(`  ${dryRun ? 'would run' : 'run'} herdr integration uninstall ${target}`);
                if (!dryRun) {
                    const result = run(binary, ['integration', 'uninstall', target]);
                    if (!result.ok) throw new Error(result.stderr || result.stdout || `failed to uninstall ${target}`);
                    manifest.herdrInstalled = manifest.herdrInstalled.filter((installed) => installed !== target);
                    saveManifest(manifest, false);
                }
            }
            if (binary) {
                for (const { id } of bundledPlugins()) {
                    print(`  ${dryRun ? 'would run' : 'run'} herdr plugin unlink ${id}`);
                    if (!dryRun) {
                        const result = run(binary, ['plugin', 'unlink', id]);
                        if (!result.ok && !/not (?:found|installed)|unknown plugin/i.test(result.stderr || result.stdout)) {
                            throw new Error(result.stderr || result.stdout || `failed to unlink ${id}`);
                        }
                    }
                }
            } else {
                print('  warn: herdr is missing; muxr.control remains registered');
                incomplete = true;
            }
            saveManifest(manifest, dryRun);
            return incomplete ? 1 : 0;
        }

        const statusResult = run(binary, ['integration', 'status']);
        if (!statusResult.ok) throw new Error(statusResult.stderr || 'herdr integration status failed');
        const statuses = parseIntegrationStatus(statusResult.stdout);
        const targets = detectedTargets(all);
        const lifecycleTargets = detectedLifecycleTargets(statuses, all);
        print(`muxr integration sync (${lifecycleTargets.length} ${all ? 'known' : 'detected'} agent providers):`);
        if (noAgentConfig) {
            print('  agent skills/instructions skipped (--no-agent-config)');
        } else {
            const skill = run(binary, ['--skill']);
            if (!skill.ok || !skill.stdout.startsWith('---')) throw new Error('herdr --skill did not return a skill file');
            const skillPath = join(stateDir(), 'integrations', 'herdr', 'SKILL.md');
            const pluginSkillPath = join(stateDir(), 'integrations', 'muxr-plugin-authoring', 'SKILL.md');
            writeOwned(skillPath, `${skill.stdout}\n`, manifest, { dryRun, force });
            writeOwned(pluginSkillPath, readFileSync(pluginAuthoringSkillSource(), 'utf8'), manifest, { dryRun, force });
            for (const target of targets) {
                const instructionPath = join(home(), ...target.instructionParts);
                writeBlock(instructionPath, managedBlock(skillPath, pluginSkillPath), manifest, { dryRun, force });
            }
        }
        saveManifest(manifest, dryRun);

        if (!dryRun) {
            const update = run(binary, ['server', 'update-agent-manifests', '--json']);
            if (!update.ok) print(`  warn: agent manifest update skipped (${update.stderr || update.stdout})`);
        } else {
            print('  would run herdr server update-agent-manifests --json');
        }
        for (const [id, status] of lifecycleTargets) {
            if (status === 'unknown') {
                print(`  warn: ${id} is not reported by this herdr build; lifecycle integration skipped`);
            } else if (status !== 'current') {
                print(`  ${dryRun ? 'would run' : 'run'} herdr integration install ${id} (${status})`);
                if (!dryRun) {
                    const result = run(binary, ['integration', 'install', id]);
                    if (!result.ok) {
                        print(`  warn: ${id} lifecycle integration skipped (${result.stderr || result.stdout || 'install failed'})`);
                        continue;
                    }
                    if (status === 'not installed' && !manifest.herdrInstalled.includes(id)) manifest.herdrInstalled.push(id);
                }
            } else {
                print(`  ✓ ${id} lifecycle integration current`);
            }
        }
        saveManifest(manifest, dryRun);
        return 0;
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}

function xml(text) {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function systemdArg(text) {
    return `"${text.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function daemonDefinition(mode) {
    if (mode !== undefined && mode !== 'hosted' && mode !== 'selfhost' && mode !== 'relay') throw new Error('--mode must be hosted, selfhost, or relay');
    const cli = realpathSync(process.argv[1]);
    const logs = join(stateDir(), 'logs');
    if (platform() === 'darwin') {
        const path = join(home(), 'Library', 'LaunchAgents', 'com.muxr.host.plist');
        const environment = [
            ...(mode === undefined ? [] : [['MUXR_MODE', mode]]),
            ...(process.env.MUXR_HOME?.trim() ? [['MUXR_HOME', stateDir()]] : []),
        ];
        const modeEnv = environment.length === 0 ? '' : `\n<key>EnvironmentVariables</key><dict>${environment.map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join('')}</dict>`;
        const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>com.muxr.host</string>\n<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(cli)}</string><string>up</string></array>${modeEnv}\n<key>RunAtLoad</key><false/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>StandardOutPath</key><string>${xml(join(logs, 'daemon.log'))}</string>\n<key>StandardErrorPath</key><string>${xml(join(logs, 'daemon.log'))}</string>\n</dict></plist>\n`;
        return { path, content, mode: 0o600 };
    }
    if (platform() === 'linux') {
        const path = join(home(), '.config', 'systemd', 'user', 'muxr.service');
        const modeEnv = [
            ...(mode === undefined ? [] : [`Environment=MUXR_MODE=${systemdArg(mode)}`]),
            ...(process.env.MUXR_HOME?.trim() ? [`Environment=MUXR_HOME=${systemdArg(stateDir())}`] : []),
        ].join('\n');
        // No After=network-online.target: it does not exist in the systemd user
        // manager and reads as ordering while being a silent no-op. The host
        // and relay retry their own connections instead.
        const content = `[Unit]\nDescription=muxr host bridge\n\n[Service]\nExecStart=${systemdArg(process.execPath)} ${systemdArg(cli)} up\n${modeEnv ? `${modeEnv}\n` : ''}Restart=on-failure\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n`;
        return { path, content, mode: 0o600 };
    }
    throw new Error('daemon services support Linux and macOS; use WSL on Windows');
}

function serviceCommand(action) {
    if (env('MUXR_NO_SERVICE_COMMANDS') === '1') return { ok: true, stdout: 'service command skipped by test environment', stderr: '' };
    if (platform() === 'darwin') {
        const domain = `gui/${process.getuid()}`;
        const label = 'com.muxr.host';
        const service = `${domain}/${label}`;
        const plist = join(home(), 'Library', 'LaunchAgents', 'com.muxr.host.plist');
        if (action === 'reload') return { ok: true, stdout: '', stderr: '' };
        if (action === 'start' || action === 'restart') {
            const loaded = run('launchctl', ['print', service]);
            if (loaded.ok) return run('launchctl', ['kickstart', '-k', service]);
            const bootstrapped = run('launchctl', ['bootstrap', domain, plist]);
            return bootstrapped.ok ? run('launchctl', ['kickstart', '-k', service]) : bootstrapped;
        }
        if (action === 'stop' || action === 'unload') return run('launchctl', ['bootout', service]);
        if (action === 'status') {
            const printed = run('launchctl', ['print', service]);
            return { ...printed, ok: printed.ok && /\bstate = running\b/.test(printed.stdout) };
        }
    }
    if (action === 'reload') return run('systemctl', ['--user', 'daemon-reload']);
    if (action === 'start') return run('systemctl', ['--user', 'enable', '--now', 'muxr.service']);
    if (action === 'restart') {
        // Restart must also enable: a stop-then-restart unit is otherwise
        // active now but silently gone at the next boot.
        const enabled = run('systemctl', ['--user', 'enable', 'muxr.service']);
        if (!enabled.ok) return enabled;
        return run('systemctl', ['--user', 'restart', 'muxr.service']);
    }
    if (action === 'stop') return run('systemctl', ['--user', 'stop', 'muxr.service']);
    if (action === 'status') return run('systemctl', ['--user', 'status', 'muxr.service', '--no-pager']);
    if (action === 'unload') return run('systemctl', ['--user', 'disable', '--now', 'muxr.service']);
    return { ok: false, stdout: '', stderr: `unknown service action ${action}` };
}

export function daemonIsRunning() {
    return serviceCommand('status').ok;
}

export function daemonMode() {
    try {
        const content = readFileSync(daemonDefinition().path, 'utf8');
        return /MUXR_MODE[\s\S]{0,80}selfhost/.test(content) ? 'selfhost'
            : /MUXR_MODE[\s\S]{0,80}relay/.test(content) ? 'relay'
                : /MUXR_MODE[\s\S]{0,80}hosted/.test(content) ? 'hosted' : undefined;
    } catch { return undefined; }
}

function publicRelayUrl(value) {
    if (typeof value !== 'string') return undefined;
    try {
        const parsed = new URL(value);
        return ['ws:', 'wss:'].includes(parsed.protocol) ? parsed.origin : undefined;
    } catch { return undefined; }
}

function selfhostControlBase(state) {
    const relay = publicRelayUrl(state?.relayUrl);
    return state?.relayLocation === 'remote' && env('MUXR_REMOTE_CONTROL_BASE')
        ? env('MUXR_REMOTE_CONTROL_BASE').replace(/\/$/, '')
        : state?.relayLocation === 'remote' && relay !== undefined
            ? relay.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:')
        : `http://127.0.0.1:${state?.relayPort}`;
}

function selfhostCredential(state) {
    return typeof state?.machineCredential === 'string' ? state.machineCredential : state?.mintSecret;
}

async function selfhostRelayHealthy(state) {
    if (state === undefined) return false;
    return fetch(`${selfhostControlBase(state)}/health`).then((response) => response.ok).catch(() => false);
}

async function advertisedRelayHealthy(state) {
    const relay = publicRelayUrl(state?.relayUrl);
    if (relay === undefined) return false;
    const base = relay.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
    return fetch(`${base}/health`, { signal: AbortSignal.timeout(10_000) }).then((response) => response.ok).catch(() => false);
}

async function remoteHostOnline(state) {
    if (state?.relayLocation !== 'remote' || env('MUXR_REMOTE_HOST_ONLINE') === '1') return true;
    const result = await api(selfhostControlBase(state), '/v1/selfhost/machine-status', {
        headers: { authorization: `Bearer ${selfhostCredential(state)}` },
    }).catch(() => undefined);
    return result?.response.ok === true && result.body.online === true;
}

export async function selfhostPublicSummary() {
    const state = readSelfhostState();
    if (state === undefined) return undefined;
    const relayHealthy = await selfhostRelayHealthy(state);
    const publicHealthy = await advertisedRelayHealthy(state);
    return {
        connectionMode: typeof state.connectionMode === 'string' ? state.connectionMode : undefined,
        relayLocation: state.relayLocation === 'remote' ? 'remote' : 'local',
        relayRole: state.relayRole === 'shared' ? 'shared' : state.relayRole === 'single-machine' ? 'single-machine' : undefined,
        relayPort: Number.isInteger(state.relayPort) ? state.relayPort : undefined,
        relayUrl: publicRelayUrl(state.relayUrl),
        webEnabled: state.webEnabled === true,
        ingressHealthy: state.connectionMode !== 'cloudflare' || cloudflaredAlive(state.ingress),
        webUrl: state.webEnabled === true ? publicRelayUrl(state.relayUrl)?.replace(/^ws/, 'http') : undefined,
        relayHealthy,
        publicHealthy,
        hostRunning: daemonIsRunning(),
        credentialExpiresAt: typeof state.credentialExpiresAt === 'string' ? state.credentialExpiresAt : undefined,
    };
}

export async function runDaemon(args = []) {
    const action = args[0] ?? 'status';
    const dryRun = args.includes('--dry-run');
    const mode = flagValue(args, '--mode');
    const force = args.includes('--force');
    const manifest = loadManifest();
    try {
        if (action === 'install') {
            const definition = daemonDefinition(mode);
            let content = definition.content;
            if (existsSync(definition.path)) {
                // Preserve Environment lines this generator did not author —
                // e.g. MUXR_HOME pinned by an earlier install would otherwise
                // be silently dropped by a re-install.
                const authored = new Set([...content.matchAll(/^Environment="?(\w+)=/gm)].map((match) => match[1]));
                const foreign = (readFileSync(definition.path, 'utf8').match(/^Environment=.*$/gm) ?? [])
                    .filter((line) => !authored.has(line.match(/^Environment="?(\w+)=/)?.[1]));
                if (foreign.length > 0) content = content.replace('[Service]\n', `[Service]\n${foreign.join('\n')}\n`);
            }
            if (!dryRun) ensurePrivateDir(join(stateDir(), 'logs'));
            writeOwned(definition.path, content, manifest, { dryRun, force, mode: definition.mode });
            if (!dryRun) manifest.entries[definition.path].scope = 'daemon';
            saveManifest(manifest, dryRun);
            if (!dryRun) {
                const reload = serviceCommand('reload');
                if (!reload.ok) throw new Error(reload.stderr || reload.stdout || 'service reload failed');
                // Every mode needs linger: without it the service dies at
                // logout and never starts on a headless or SSH-only box.
                if (platform() === 'linux' && env('MUXR_NO_SERVICE_COMMANDS') !== '1') {
                    const username = userInfo().username;
                    const linger = run('loginctl', ['show-user', username, '-p', 'Linger', '--value']);
                    if (!linger.ok || linger.stdout.trim() !== 'yes') {
                        const enabled = run('loginctl', ['enable-linger', username]);
                        // WSL and containers have no loginctl; warn, don't fail.
                        if (!enabled.ok) print(`  warn: could not enable boot persistence (${enabled.stderr || enabled.stdout || 'loginctl unavailable'}); the service will not restart after logout`);
                    }
                }
            }
            print(`Daemon registered. Start it with: muxr daemon start`);
            return 0;
        }
        if (action === 'uninstall') {
            const entries = Object.entries(manifest.entries).filter(([, entry]) => entry.scope === 'daemon');
            for (const [path, entry] of entries) removeManaged(path, entry, manifest, { dryRun, force });
            saveManifest(manifest, dryRun);
            if (!dryRun) {
                serviceCommand('unload');
                await stopOwnedSelfhostRelay();
                cleanupManagedIngress(readSelfhostState());
                serviceCommand('reload');
            }
            print('Daemon registration and muxr-owned ingress removed; muxr data and unrelated services were left intact.');
            return 0;
        }
        if (action === 'logs') {
            if (platform() === 'darwin') {
                const path = join(stateDir(), 'logs', 'daemon.log');
                print(existsSync(path) ? readFileSync(path, 'utf8') : 'No daemon log yet.');
                return 0;
            }
            const result = run('journalctl', ['--user', '-u', 'muxr.service', '-n', '100', '--no-pager']);
            print(result.stdout || result.stderr || 'No daemon log yet.');
            return result.ok ? 0 : 1;
        }
        if (!['start', 'stop', 'restart', 'status'].includes(action)) throw new Error('usage: muxr daemon install|uninstall|start|stop|restart|status|logs');
        const result = serviceCommand(action);
        print(result.stdout || result.stderr || `daemon ${action}: ok`);
        return result.ok || action === 'status' ? 0 : 1;
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}

function controlUrl() {
    return env('MUXR_CONTROL_URL')
        || env('MUXR_PUBLIC_BASE_URL')
        || (PACKAGED_CONTROL_URL.startsWith('https://') ? PACKAGED_CONTROL_URL : undefined);
}

function cliVersion() {
    for (const path of [join(dirname(realpathSync(process.argv[1])), 'package.json'), join(process.cwd(), 'package.json')]) {
        try {
            const version = JSON.parse(readFileSync(path, 'utf8')).version;
            if (typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version)) return version;
        } catch {}
    }
    return 'unknown';
}

function loadAuthState() {
    try {
        const info = lstatSync(authPath());
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
            throw new Error(`${authPath()} must be a regular owner-only file`);
        }
        const parsed = JSON.parse(readFileSync(authPath(), 'utf8'));
        return parsed.version === 1 ? parsed : undefined;
    } catch (cause) {
        if (cause?.code === 'ENOENT') return undefined;
        throw cause;
    }
}

function machineIdentity(existing) {
    if (existing?.machine?.crypto?.signingPublicKey && existing?.machine?.crypto?.signingSecretKey
        && existing?.machine?.crypto?.boxPublicKey && existing?.machine?.crypto?.boxSecretKey
        && existing?.machine?.crypto?.dataKey && existing?.machine?.id) return existing.machine;
    const signing = nacl.sign.keyPair();
    const box = nacl.box.keyPair();
    const publicKey = base64(signing.publicKey);
    return {
        id: `machine-${hash(publicKey).slice(0, 16)}`,
        name: hostname(),
        publicKey,
        crypto: {
            signingPublicKey: publicKey,
            signingSecretKey: base64(signing.secretKey),
            boxPublicKey: base64(box.publicKey),
            boxSecretKey: base64(box.secretKey),
            dataKey: base64(nacl.randomBytes(32)),
            keyVersion: 1,
            devices: [],
        },
    };
}

async function api(base, path, options = {}) {
    const response = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
        ...options,
        headers: { 'content-type': 'application/json', ...options.headers },
        signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
}

function maybeOpenVerification(url, headless) {
    if (headless || process.env.SSH_CONNECTION || process.env.TERMUX_VERSION || !process.stdout.isTTY) return;
    const opener = platform() === 'darwin' ? 'open' : 'xdg-open';
    if (!executable(opener)) return;
    const result = run(opener, [url]);
    if (!result.ok) print('  warn: could not open the browser; use the URL below');
}

async function runHostedLogin(args = []) {
    if (process.env.MUXR_SKIP_HOSTED_AUTH === '1') {
        print('  Hosted login skipped by explicit test/development override.');
        return 0;
    }
    const base = controlUrl();
    if (!base) throw new Error('MUXR_CONTROL_URL (or MUXR_PUBLIC_BASE_URL) is required for hosted login');
    if (!/^https:\/\//.test(base) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(base)) {
        throw new Error('hosted control URL must use HTTPS (HTTP is allowed only on loopback)');
    }
    const current = loadAuthState();
    const machine = machineIdentity(current);
    let pending = current?.machine?.id === machine.id ? current?.pending : undefined;
    if (!pending || pending.controlUrl !== base || Date.parse(pending.expiresAt) <= Date.now()) {
        const started = await api(base, '/v1/device-authorizations', {
            method: 'POST',
            body: JSON.stringify({
                machine_slug: machine.id,
                machine_name: machine.name,
                machine_public_key: machine.publicKey,
                platform: `${platform()}-${process.arch}`,
                cli_version: cliVersion(),
            }),
        });
        if (!started.response.ok || typeof started.body.device_code !== 'string') {
            throw new Error(started.body.error || `device authorization failed (${started.response.status})`);
        }
        pending = {
            controlUrl: base,
            deviceCode: started.body.device_code,
            userCode: started.body.user_code,
            verificationUri: started.body.verification_uri,
            interval: started.body.interval,
            expiresAt: new Date(Date.now() + started.body.expires_in * 1000).toISOString(),
        };
        ensurePrivateDir(stateDir());
        atomicWrite(authPath(), `${JSON.stringify({ version: 1, machine, pending }, null, 2)}\n`);
    }
    print(`  Open: ${pending.verificationUri}`);
    print(`  Code: ${pending.userCode}`);
    print('  Confirm the same code and machine details before approving.');
    maybeOpenVerification(pending.verificationUri, args.includes('--headless'));

    let interval = Number(pending.interval) || 5;
    let entitlementNoticeShown = false;
    while (Date.parse(pending.expiresAt) > Date.now()) {
        await new Promise((resolve) => setTimeout(resolve, interval * 1000));
        const polled = await api(base, '/v1/device-authorizations/token', {
            method: 'POST',
            body: JSON.stringify({ device_code: pending.deviceCode }),
        });
        if (polled.response.ok && typeof polled.body.access_token === 'string') {
            const auth = {
                version: 1,
                controlUrl: base,
                relayUrl: polled.body.relay_url,
                credential: polled.body.access_token,
                credentialExpiresAt: new Date(Date.now() + polled.body.expires_in * 1000).toISOString(),
                account: polled.body.account,
                machine,
            };
            atomicWrite(authPath(), `${JSON.stringify(auth, null, 2)}\n`);
            print(`  ✓ signed in as ${auth.account.email}`);
            return 0;
        }
        if (polled.body.error === 'authorization_pending') continue;
        if (polled.body.error === 'entitlement_pending') {
            if (!entitlementNoticeShown) {
                entitlementNoticeShown = true;
                print('  Payment received — activating…');
                print(`  Billing and activation: ${base}/account`);
                maybeOpenVerification(`${base}/account`, args.includes('--headless'));
            }
            continue;
        }
        if (polled.body.error === 'slow_down') {
            interval = Number(polled.body.interval) || interval + 5;
            continue;
        }
        if (polled.body.error === 'access_denied') {
            atomicWrite(authPath(), `${JSON.stringify({ version: 1, machine }, null, 2)}\n`);
            throw new Error('device authorization was denied');
        }
        if (polled.body.error === 'expired_token' || polled.body.error === 'invalid_grant') {
            atomicWrite(authPath(), `${JSON.stringify({ version: 1, machine }, null, 2)}\n`);
            break;
        }
        throw new Error(polled.body.error || `device authorization poll failed (${polled.response.status})`);
    }
    throw new Error('device authorization expired; rerun the command to start a new session');
}

const selfhostPath = () => join(stateDir(), 'selfhost.json');
const relayEntry = () => existsSync(fileURLToPath(new URL('./relay.js', import.meta.url)))
    ? fileURLToPath(new URL('./relay.js', import.meta.url))
    : fileURLToPath(new URL('../apps/relay/dist/main.js', import.meta.url));

function readSelfhostState() {
    try {
        if (!existsSync(selfhostPath())) return undefined;
        const parsed = JSON.parse(readFileSync(selfhostPath(), 'utf8'));
        return parsed?.version === 1 ? parsed : undefined;
    } catch {
        // A truncated selfhost.json must not kill `muxr`/`muxr doctor` — the
        // command whose job is diagnosing a broken install.
        return undefined;
    }
}

/**
 * True when selfhost.json exists but does not parse. Corrupt is not "not
 * configured": setup must never mint a new machine identity over it (that
 * destroys every pairing), so callers distinguish the two.
 */
export function selfhostStateUnreadable() {
    if (!existsSync(selfhostPath())) return false;
    try {
        JSON.parse(readFileSync(selfhostPath(), 'utf8'));
        return false;
    } catch {
        return true;
    }
}

/** Menu-only summary used by cli.mjs to guide browser pairing. */
export function browserHostingReady() {
    const state = readSelfhostState();
    return state !== undefined && state.webEnabled === true && publicRelayUrl(state.relayUrl)?.startsWith('wss://') === true;
}

export function selfhostConfigured() { return readSelfhostState() !== undefined; }

function writeSelfhostState(state) {
    atomicWrite(selfhostPath(), `${JSON.stringify(state, null, 2)}\n`);
}

function pendingRemotePath() { return join(stateDir(), 'selfhost.pending.json'); }

export function hasPendingRemoteConnect() { return existsSync(pendingRemotePath()); }

async function resumeRemoteConnect(args = []) {
    if (!hasPendingRemoteConnect()) throw new Error('no interrupted remote enrollment is waiting to resume');
    const pending = JSON.parse(readFileSync(pendingRemotePath(), 'utf8'));
    if (pending?.version !== 1 || pending.relayLocation !== 'remote' || typeof pending.machineCredential !== 'string'
        || typeof pending.credentialExpiresAt !== 'string' || Date.parse(pending.credentialExpiresAt) <= Date.now()) {
        throw new Error('pending remote enrollment is invalid or expired; create a fresh enrollment on the relay server');
    }
    const check = await api(selfhostControlBase(pending), '/v1/selfhost/machine-status', {
        headers: { authorization: `Bearer ${pending.machineCredential}` },
    }).catch(() => { throw new Error('could not reach the shared relay; check the network and try Resume again'); });
    if (!check.response.ok) throw new Error(check.body.error || 'pending machine credential was rejected');
    const current = readSelfhostState();
    if (current !== undefined) writeFileSync(join(stateDir(), 'selfhost.previous.json'), `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    writeSelfhostState(pending);
    rmSync(pendingRemotePath(), { force: true });
    await startMuxrDaemon('selfhost', args, true);
    for (let attempt = 0; attempt < 40 && !(await remoteHostOnline(pending)); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 250));
    if (!(await remoteHostOnline(pending))) throw new Error('remote enrollment was restored, but the host did not authenticate; run `muxr doctor`');
    rmSync(join(stateDir(), 'selfhost.previous.json'), { force: true });
    print('  ✓ resumed the remote relay connection');
    return 0;
}

function lanAddress() {
    for (const list of Object.values(networkInterfaces())) {
        for (const info of list ?? []) {
            if (info.family === 'IPv4' && !info.internal) return info.address;
        }
    }
    return undefined;
}

export function tailscaleIngress(args) {
    if (args.includes('--tunnel') || flagValue(args, '--advertise') || args.includes('--tailscale-direct')) return undefined;
    const status = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8' });
    if (status.error?.code === 'ENOENT') return undefined;
    if (status.status !== 0) {
        // A spawn error (EACCES, …) gives status:null and no stderr stream.
        const detail = (status.stderr ?? status.error?.message ?? '').trim();
        throw new Error(`Tailscale is installed but unavailable: ${detail || 'sign in or use --advertise'}`);
    }
    try {
        const parsed = JSON.parse(status.stdout);
        const dnsName = parsed?.Self?.DNSName?.replace(/\.$/, '');
        if (!dnsName) throw new Error('Tailscale MagicDNS name is unavailable; enable MagicDNS or use --tailscale-direct');
        return { dnsName };
    } catch (cause) {
        if (cause instanceof SyntaxError) throw new Error('Tailscale returned invalid status JSON');
        throw cause;
    }
}

function tailscaleRootProxy(value, dnsName) {
    const web = value?.Web;
    if (web === null || typeof web !== 'object') return undefined;
    const exact = dnsName ? web[`${dnsName}:443`]?.Handlers?.['/']?.Proxy : undefined;
    if (typeof exact === 'string') return exact;
    if (dnsName) return undefined;
    const roots = Object.entries(web)
        .filter(([address]) => address.endsWith(':443'))
        .map(([, config]) => config?.Handlers?.['/']?.Proxy)
        .filter((proxy) => typeof proxy === 'string');
    return roots.length === 1 ? roots[0] : undefined;
}

function cloudflaredAlive(ingress) {
    if (ingress?.kind !== 'cloudflare-quick') return false;
    const pid = Number(ingress.pid);
    const command = Number.isSafeInteger(pid) && pid > 1 ? run(env('MUXR_PS_BIN') || 'ps', ['-ww', '-p', String(pid), '-o', 'command=']) : { ok: false };
    return command.ok && command.stdout.includes(`cloudflared tunnel --url http://127.0.0.1:${ingress.port}`);
}

function cleanupManagedIngress(state) {
    const ingress = state?.ingress;
    if (ingress?.kind === 'cloudflare-quick') {
        if (cloudflaredAlive(ingress)) process.kill(Number(ingress.pid), 'SIGTERM');
        return;
    }
    if (ingress?.kind !== 'tailscale-serve') return;
    const current = spawnSync('tailscale', ['serve', 'status', '--json'], { encoding: 'utf8' });
    if (current.error?.code === 'ENOENT') return;
    if (current.status !== 0) throw new Error('cannot inspect the previous muxr Tailscale Serve route; leaving it unchanged');
    let parsed;
    try { parsed = JSON.parse(current.stdout || '{}'); }
    catch { throw new Error('Tailscale Serve returned invalid status JSON; leaving it unchanged'); }
    const expected = `http://127.0.0.1:${ingress.port}`;
    const rootProxy = tailscaleRootProxy(parsed, ingress.dnsName);
    if (rootProxy === undefined) return;
    if (rootProxy !== expected) throw new Error('the previous Tailscale Serve route changed outside muxr; leaving it unchanged');
    const disabled = spawnSync('tailscale', ['serve', '--https=443', 'off'], { encoding: 'utf8' });
    if (disabled.status !== 0) throw new Error(`could not remove the previous muxr Tailscale Serve route: ${disabled.stderr.trim() || disabled.stdout.trim()}`);
}

export async function resolveAdvertise(args, port, tailscale) {
    const explicit = flagValue(args, '--advertise')?.trim();
    if (explicit) {
        let parsed;
        try { parsed = new URL(explicit); }
        catch { throw new Error('--advertise must be a valid ws:// or wss:// URL'); }
        if (!['ws:', 'wss:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
            throw new Error('--advertise must be a root ws:// or wss:// URL without credentials, paths, query, or fragment');
        }
        return { url: parsed.toString().replace(/\/$/, ''), note: 'explicit --advertise' };
    }
    if (args.includes('--tunnel')) {
        const check = spawnSync('cloudflared', ['--version'], { encoding: 'utf8' });
        if (check.error) throw new Error('cloudflared not found; install it or use --advertise=<url>');
        const logPath = join(stateDir(), 'logs', 'cloudflared.log');
        ensurePrivateDir(dirname(logPath));
        const out = openSync(logPath, 'w', 0o600);
        chmodSync(logPath, 0o600);
        const proc = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], { detached: true, stdio: ['ignore', out, out] });
        proc.unref();
        let tunnelUrl;
        for (let i = 0; i < 50 && tunnelUrl === undefined; i++) {
            await new Promise((resolve) => setTimeout(resolve, 400));
            const match = readFileSync(logPath, 'utf8').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
            if (match) tunnelUrl = match[0];
        }
        if (tunnelUrl === undefined) {
            proc.kill('SIGTERM');
            throw new Error(`cloudflared did not print a tunnel URL; see ${logPath}`);
        }
        return {
            url: tunnelUrl.replace(/^https/, 'wss'),
            note: 'cloudflare quick tunnel (ephemeral URL; use a named tunnel for permanence)',
            ingress: { kind: 'cloudflare-quick', pid: proc.pid, port },
        };
    }
    if (tailscale) {
        const current = spawnSync('tailscale', ['serve', 'status', '--json'], { encoding: 'utf8' });
        if (current.status !== 0) throw new Error(`cannot inspect Tailscale Serve ownership: ${current.stderr.trim() || 'status failed'}`);
        let rootProxy;
        try { rootProxy = tailscaleRootProxy(JSON.parse(current.stdout || '{}'), tailscale.dnsName); }
        catch { throw new Error('Tailscale Serve returned invalid status JSON'); }
        const expected = `http://127.0.0.1:${port}`;
        if (rootProxy !== undefined && rootProxy !== expected) throw new Error('Tailscale Serve root is already owned by another service; use --tailscale-direct or remove it yourself');
        const serve = rootProxy === expected
            ? { status: 0, stdout: '', stderr: '' }
            : spawnSync('tailscale', ['serve', '--yes', '--bg', '--https=443', expected], { encoding: 'utf8' });
        if (serve.status !== 0) throw new Error(`tailscale serve failed: ${serve.stderr.trim() || serve.stdout.trim() || 'check operator permissions'}; use --tailscale-direct for direct tailnet mode`);
        return {
            url: `wss://${tailscale.dnsName}`,
            note: 'Tailscale Serve (private tailnet HTTPS)',
            ingress: { kind: 'tailscale-serve', port, dnsName: tailscale.dnsName },
        };
    }
    const status = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8' });
    if (status.status === 0) {
        try {
            const ip = JSON.parse(status.stdout)?.Self?.TailscaleIPs?.find((value) => /^100\./.test(value));
            if (ip) return { url: `ws://${ip}:${port}`, note: 'direct Tailscale address' };
        } catch {}
    }
    const lan = lanAddress();
    if (lan !== undefined) return { url: `ws://${lan}:${port}`, note: 'LAN only — phone must be on this network; pair only on a network you trust' };
    throw new Error('no advertise address; use --advertise <url>');
}

function relayDiscovery(state) {
    return state?.machine?.id && state?.relayUrl ? {
        machineId: state.machine.id,
        name: state.machine.name,
        relayUrl: state.relayUrl,
        mode: state.connectionMode,
    } : undefined;
}

async function ensureSelfhostRelay(port, webRoot, host = '0.0.0.0', webOrigin, discovery) {
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok ? r.json() : undefined).catch(() => undefined);
    const healthy = health?.ok === true;
    const dataDir = join(stateDir(), 'relay');
    if (healthy) {
        // A ghost relay (old process, deleted dataDir) answers health but has no
        // mint secret on disk — refuse rather than failing mysteriously later.
        if (!existsSync(join(dataDir, 'mint-secret'))) {
            throw new Error(`port ${port} answers but is not this relay's state; stop the stale relay on :${port} first`);
        }
        if (health.webEnabled !== (webRoot !== undefined) || health.bindHost !== host) {
            throw new Error(`relay on :${port} is already running with different web/bind settings; stop it, then rerun setup`);
        }
        return;
    }
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const logPath = join(stateDir(), 'logs', 'relay.log');
    ensurePrivateDir(dirname(logPath));
    const out = openSync(logPath, 'a', 0o600);
    chmodSync(logPath, 0o600);
    const proc = spawn(process.execPath, [relayEntry()], {
        detached: true,
        stdio: ['ignore', out, out],
        env: {
            ...process.env,
            MUXR_RELAY_LOCAL_AUTHORITY: '1',
            MUXR_RELAY_MDNS: discovery ? '1' : '0',
            ...(discovery?.machineId ? { MUXR_RELAY_MDNS_MACHINE: discovery.machineId } : {}),
            ...(discovery?.name ? { MUXR_RELAY_MDNS_NAME: `muxr ${discovery.name}` } : {}),
            ...(discovery?.relayUrl ? { MUXR_RELAY_MDNS_RELAY: discovery.relayUrl } : {}),
            ...(discovery?.mode ? { MUXR_RELAY_MDNS_MODE: discovery.mode } : {}),
            MUXR_RELAY_PORT: String(port),
            MUXR_RELAY_HOST: host,
            MUXR_RELAY_DATA_DIR: dataDir,
            ...(webRoot ? { MUXR_WEB_ROOT: webRoot } : {}),
            ...(webOrigin ? { MUXR_ALLOWED_ORIGINS: webOrigin } : {}),
        },
    });
    proc.unref();
    for (let i = 0; i < 25; i++) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)) return;
    }
    throw new Error(`self-host relay did not come up on :${port}; see ${logPath}`);
}

async function stopOwnedSelfhostRelay() {
    const state = readSelfhostState();
    if (state === undefined || state.relayLocation === 'remote') return undefined;
    const port = Number(state.relayPort);
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.ok ? response.json() : undefined).catch(() => undefined);
    if (health?.ok !== true) return undefined;
    const pidPath = join(stateDir(), 'relay', 'relay.pid');
    const pid = Number(existsSync(pidPath) ? readFileSync(pidPath, 'utf8').trim() : '');
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('running relay has no valid pid file; leaving it untouched');
    const command = run(env('MUXR_PS_BIN') || 'ps', ['-ww', '-p', String(pid), '-o', 'command=']);
    const relayCommand = command.ok ? command.stdout.trim() : '';
    if (!/(?:^|\s)\S*\/relay\.js(?:\s|$)/.test(relayCommand) && !relayCommand.includes(relayEntry())) {
        throw new Error('relay pid does not belong to a muxr relay process; leaving it untouched');
    }
    try { process.kill(pid, 'SIGTERM'); }
    catch (cause) { if (cause?.code === 'ESRCH') return { state, health, port }; else throw cause; }
    for (let attempt = 0; attempt < 30; attempt += 1) {
        const stopped = await fetch(`http://127.0.0.1:${port}/health`).then(() => false).catch(() => true);
        if (stopped) return { state, health, port };
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('relay did not stop; leaving the existing process in place');
}

function persistRelayRuntimeState({ state, health }) {
    state.bindHost = health.bindHost === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0';
    state.webEnabled = health.webEnabled === true;
    state.webRoot = state.webEnabled ? join(dirname(realpathSync(process.argv[1])), 'web') : undefined;
    state.webOrigin = state.webEnabled && typeof state.relayUrl === 'string' ? state.relayUrl.replace(/^wss/, 'https') : undefined;
    writeSelfhostState(state);
}

export async function stopSelfhostRelayIfRunning() {
    const previous = await stopOwnedSelfhostRelay();
    if (previous === undefined) return false;
    persistRelayRuntimeState(previous);
    return true;
}

export async function restartSelfhostRelayIfRunning() {
    const previous = await stopOwnedSelfhostRelay();
    if (previous === undefined) return false;
    persistRelayRuntimeState(previous);
    const { state, port } = previous;
    await ensureSelfhostRelay(port, state.webRoot, state.bindHost, state.webOrigin, relayDiscovery(state));
    return true;
}

function flagValue(args, name) {
    const inline = args.find((a) => a.startsWith(`${name}=`));
    if (inline !== undefined) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
}

async function startMuxrDaemon(mode, args = [], restartRunning = true) {
    const dryRun = args.includes('--dry-run');
    const common = [...(dryRun ? ['--dry-run'] : []), ...(args.includes('--force') ? ['--force'] : [])];
    if ((await runDaemon(['install', '--mode', mode, ...common])) !== 0) throw new Error('daemon registration failed');
    if (dryRun) {
        print(`  would start muxr services in ${mode} mode`);
        return;
    }
    const running = daemonIsRunning();
    if (!running || restartRunning) {
        const action = running ? 'restart' : 'start';
        if ((await runDaemon([action])) !== 0) throw new Error(`muxr host did not ${action}`);
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
        if (serviceCommand('status').ok) {
            const relayReady = mode !== 'selfhost' && mode !== 'relay' || await (async () => {
                const state = readSelfhostState();
                return selfhostRelayHealthy(state);
            })();
            if (relayReady) {
                print(`  ✓ muxr services running in ${mode} mode`);
                return;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('muxr host service did not become ready; run `muxr daemon logs`');
}

export async function runSelfHost(args = []) {
    let pendingIngress;
    const port = Number(flagValue(args, '--port') ?? 8792);
    const relayOnly = args.includes('--relay-only');
    const managedRelay = args.includes('--managed-relay');
    const hostOnly = args.includes('--host-only');
    const dryRun = args.includes('--dry-run');
    const web = args.includes('--web');
    const pairKind = args.includes('--pair-browser') ? 'browser' : 'native';
    const noPair = args.includes('--no-pair');
    const connectionMode = flagValue(args, '--connection-mode');
    const reconfigure = args.includes('--reconfigure');
    if (web && !process.stdout.isTTY && !args.includes('--yes')) {
        error('--web requires an interactive trust confirmation or explicit --yes');
        return 1;
    }
    const webRoot = flagValue(args, '--web-root') ?? join(dirname(realpathSync(process.argv[1])), 'web');
    try {
        if (relayOnly && hostOnly) throw new Error('choose only one of --relay-only or --host-only');
        if (selfhostStateUnreadable()) {
            // Corrupt is not "not configured": reconfiguring would mint a new
            // machine identity and destroy every pairing.
            throw new Error(`${selfhostPath()} exists but is unreadable (truncated or corrupt); refusing to reconfigure over it. Move it aside when you are sure — \`mv ${selfhostPath()} ${selfhostPath()}.broken\` — then rerun`);
        }
        if (web && process.stdout.isTTY && !args.includes('--yes')) {
            print('Web access creates an 8-hour read-only browser device. Secret material is WebCrypto-wrapped in IndexedDB; close shared browsers and revoke them from `muxr devices`.');
            const approved = await askVisible('Continue with browser access? [y/N] ');
            if (!approved) return 0;
        }
        if (dryRun) {
            print(`  would start ${relayOnly ? 'the self-host relay' : hostOnly ? 'the self-host agent host' : 'the self-host relay and agent host'}`);
            if (!relayOnly) print('  would create a single-use encrypted mobile pairing QR');
            return 0;
        }
        let state = readSelfhostState();
        if (hostOnly) {
            if (state === undefined) throw new Error('no self-host state yet; run `muxr self-host` first');
            await startMuxrDaemon('selfhost', args);
            print('Ready — the muxr host is connected to your relay.');
            return 0;
        }
        if (state === undefined) {
            state = { version: 1, machine: machineIdentity(undefined), relayPort: port };
        }
        const hostWasRunning = daemonIsRunning();
        const explicitAdvertise = flagValue(args, '--advertise')?.replace(/\/$/, '');
        const sameConfiguration = state.relayPort === port
            && state.connectionMode === connectionMode
            && state.webEnabled === web
            && (connectionMode !== 'external' && connectionMode !== 'lan' || state.relayUrl === explicitAdvertise);
        if (!sameConfiguration && reconfigure) {
            cleanupManagedIngress(state);
            if (hostWasRunning && (await runDaemon(['stop'])) !== 0) throw new Error('could not stop the managed muxr service before reconfiguration');
            await stopOwnedSelfhostRelay();
            delete state.ingress;
        }
        state.relayPort = port;
        if (web && !existsSync(join(webRoot, 'index.html'))) throw new Error(`web client missing at ${webRoot}; install a package with the web client or pass --web-root`);
        // Missing Tailscale is fine; BROKEN Tailscale (daemon down, MagicDNS
        // off) must not abort setup — the direct/LAN fallbacks still work.
        let tailscale;
        try {
            tailscale = tailscaleIngress(args);
        } catch (cause) {
            print(`  warn: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
        const advertise = sameConfiguration && connectionMode === 'cloudflare' && typeof state.relayUrl === 'string' && cloudflaredAlive(state.ingress)
            ? { url: state.relayUrl, note: 'existing Cloudflare quick tunnel', ingress: state.ingress }
            : await resolveAdvertise(args, port, tailscale);
        pendingIngress = advertise.ingress?.kind === 'cloudflare-quick' ? advertise.ingress : undefined;
        if (web && !advertise.url.startsWith('wss://')) throw new Error('--web requires HTTPS (Tailscale Serve, a named HTTPS tunnel, or --advertise wss://...)');
        const bindHost = tailscale || args.includes('--tunnel') || web || explicitAdvertise?.startsWith('wss://') ? '127.0.0.1' : '0.0.0.0';
        const webOrigin = web ? advertise.url.replace(/^wss/, 'https') : undefined;
        await ensureSelfhostRelay(port, web ? webRoot : undefined, bindHost, webOrigin, {
            machineId: state.machine.id,
            name: state.machine.name,
            relayUrl: advertise.url,
            mode: connectionMode,
        });
        const mintPath = join(stateDir(), 'relay', 'mint-secret');
        const mintInfo = lstatSync(mintPath);
        if (!mintInfo.isFile() || mintInfo.isSymbolicLink() || (mintInfo.mode & 0o077) !== 0) {
            throw new Error(`${mintPath} must be a regular owner-only file`);
        }
        const secretRaw = JSON.parse(readFileSync(mintPath, 'utf8'));
        state.mintSecret = secretRaw;
        state.relayUrl = advertise.url;
        state.relayLocation = 'local';
        state.relayRole = managedRelay ? 'shared' : 'single-machine';
        state.connectionMode = connectionMode;
        state.webEnabled = web;
        state.webRoot = web ? webRoot : undefined;
        state.webOrigin = webOrigin;
        state.bindHost = bindHost;
        state.ingress = advertise.ingress;
        writeSelfhostState(state);
        pendingIngress = undefined;
        print(`  ✓ self-host relay on :${port} (${advertise.note})`);
        print(`  ✓ advertise ${advertise.url}`);
        if (web) print(`  ✓ web client ${advertise.url.replace(/^ws/, 'http')}`);
        if (relayOnly) {
            if (managedRelay) {
                if (env('MUXR_NO_SERVICE_COMMANDS') !== '1') await stopOwnedSelfhostRelay();
                try { await startMuxrDaemon('relay', args, !sameConfiguration || !hostWasRunning); }
                catch (cause) {
                    await ensureSelfhostRelay(port, web ? webRoot : undefined, bindHost, webOrigin, relayDiscovery(state)).catch(() => undefined);
                    throw new Error(`the supervised relay service did not start; the temporary relay was restored when possible: ${cause instanceof Error ? cause.message : String(cause)}`);
                }
                delete state.machine;
                writeSelfhostState(state);
                print('Shared relay service ready. Create a machine enrollment from the muxr menu.');
            } else {
                print('Relay ready. Run `muxr self-host --host-only` on the machine holding this state.');
            }
            return 0;
        }
        if (env('MUXR_NO_SERVICE_COMMANDS') !== '1' && (!sameConfiguration || !hostWasRunning)) await stopOwnedSelfhostRelay();
        await startMuxrDaemon('selfhost', args, !sameConfiguration || !hostWasRunning);
        if (noPair) {
            print('Ready — existing paired devices will reconnect automatically.');
            return 0;
        }
        return await withSelfhostRotationLock(() => runSelfhostPair(state, pairKind));
    } catch (cause) {
        if (pendingIngress && cloudflaredAlive(pendingIngress)) process.kill(Number(pendingIngress.pid), 'SIGTERM');
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}

async function withSelfhostRotationLock(operation) {
    const lock = join(stateDir(), 'selfhost-rotation.lock');
    const claim = () => {
        try {
            writeFileSync(lock, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, { mode: 0o600, flag: 'wx' });
        } catch (cause) {
            if (cause?.code !== 'EEXIST') throw cause;
            const before = lstatSync(lock);
            let owner;
            try { owner = JSON.parse(readFileSync(lock, 'utf8')); }
            catch { throw new Error('pairing lock is unreadable; remove it only after confirming no muxr setup is running'); }
            if (!Number.isInteger(owner?.pid)) throw new Error('pairing lock has no process owner; remove it only after confirming no muxr setup is running');
            try {
                process.kill(owner.pid, 0);
                throw new Error(`another pairing or device rotation is running (pid ${owner.pid})`);
            } catch (error) {
                if (error?.code !== 'ESRCH') throw error;
            }
            const after = lstatSync(lock);
            if (after.ino !== before.ino || after.dev !== before.dev) return claim();
            rmSync(lock, { force: true });
            try {
                writeFileSync(lock, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, { mode: 0o600, flag: 'wx' });
            } catch (error) {
                if (error?.code === 'EEXIST') return claim();
                throw error;
            }
        }
    };
    claim();
    try { return await operation(); }
    finally { rmSync(lock, { force: true }); }
}

async function selfhostDevices(state) {
    const result = await api(selfhostControlBase(state), `/v1/selfhost/devices?machine=${encodeURIComponent(state.machine.id)}`, {
        headers: { authorization: `Bearer ${selfhostCredential(state)}` },
    });
    if (!result.response.ok || !Array.isArray(result.body.devices)) {
        throw new Error(result.body.error || 'could not list paired devices; start the self-host relay first');
    }
    return result.body.devices;
}

export async function runDevices(command = 'list', args = []) {
    try {
        const state = readSelfhostState();
        if (state?.machine?.crypto === undefined || typeof selfhostCredential(state) !== 'string') {
            throw new Error('no self-host pairing state; run `muxr self-host` first');
        }
        if (command === 'list') {
            const devices = await selfhostDevices(state);
            if (devices.length === 0) print('No paired devices.');
            else devices.forEach((device, index) => print(`  ${index + 1}. ${device.name || 'phone'} — paired ${new Date(device.createdAt).toLocaleDateString()}`));
            return 0;
        }
        if (command !== 'revoke') throw new Error('usage: muxr devices list | muxr devices revoke <number|name>');
        await withSelfhostRotationLock(async () => {
            let current = readSelfhostState();
            let pending = current?.machine?.crypto?.pendingRotation;
            if (pending?.kind !== 'selfhost-revoke-v1') {
                const reference = args.join(' ').trim();
                if (reference === '') throw new Error('choose a device from `muxr devices list`');
                const devices = await selfhostDevices(current);
                const position = /^\d+$/.test(reference) ? Number(reference) - 1 : -1;
                const named = devices.filter((device) => device.name?.toLowerCase() === reference.toLowerCase());
                const target = position >= 0 ? devices[position] : named.length === 1 ? named[0] : undefined;
                if (target === undefined) throw new Error(named.length > 1 ? 'device name is ambiguous; use its list number' : 'device not found');
                const local = current.machine.crypto.devices;
                if (!local.some((device) => device.deviceId === target.deviceId)) {
                    const cleaned = await api(selfhostControlBase(current), `/v1/selfhost/devices/${encodeURIComponent(target.deviceId)}`, {
                        method: 'DELETE', headers: { authorization: `Bearer ${selfhostCredential(current)}` },
                    });
                    if (!cleaned.response.ok) throw new Error(cleaned.body.error || 'incomplete pairing cleanup failed');
                    print(`  ✓ revoked incomplete pairing for ${target.name || 'phone'}`);
                    return;
                }
                if (devices.some((device) => device.deviceId !== target.deviceId
                    && !local.some((entry) => entry.deviceId === device.deviceId))) {
                    throw new Error('another incomplete pairing exists; revoke it first');
                }
                const keyVersion = current.machine.crypto.keyVersion + 1;
                const dataKey = base64(nacl.randomBytes(32));
                const nextDevices = local.filter((device) => device.deviceId !== target.deviceId).map((device) => {
                    const expiresAt = device.kind === 'browser'
                        ? Math.min(Date.parse(device.expiresAt), Date.now() + BROWSER_GRANT_TTL_MS)
                        : DURABLE_GRANT_EXPIRES_AT;
                    return {
                        ...device,
                        ingressKey: base64(nacl.randomBytes(32)),
                        expiresAt: new Date(expiresAt).toISOString(),
                    };
                });
                const grants = nextDevices.map((device) => ({
                    deviceId: device.deviceId,
                    grant: JSON.stringify(createDeviceGrant({
                        machineId: current.machine.id,
                        machineSigningSecretKey: current.machine.crypto.signingSecretKey,
                        machineKey: { publicKey: current.machine.crypto.boxPublicKey, secretKey: current.machine.crypto.boxSecretKey },
                        deviceId: device.deviceId,
                        devicePublicKey: device.devicePublicKey,
                        dataKey,
                        ingressKey: device.ingressKey,
                        keyVersion,
                        expiresAt: Date.parse(device.expiresAt),
                    })),
                }));
                pending = {
                    kind: 'selfhost-revoke-v1',
                    revokedDeviceId: target.deviceId,
                    revokedDeviceName: target.name || 'phone',
                    previousKeyVersion: current.machine.crypto.keyVersion,
                    keyVersion,
                    dataKey,
                    devices: nextDevices,
                    grants,
                };
                current.machine.crypto.pendingRotation = pending;
                writeSelfhostState(current);
            }

            const base = selfhostControlBase(current);
            const headers = { authorization: `Bearer ${selfhostCredential(current)}` };
            const revoked = await api(base, `/v1/selfhost/devices/${encodeURIComponent(pending.revokedDeviceId)}`, {
                method: 'DELETE', headers,
            });
            if (!revoked.response.ok && revoked.response.status !== 404) throw new Error(revoked.body.error || 'device credential revocation failed');

            current = readSelfhostState();
            if (current.machine.crypto.keyVersion === pending.previousKeyVersion) {
                current.machine.crypto.dataKey = pending.dataKey;
                current.machine.crypto.keyVersion = pending.keyVersion;
                current.machine.crypto.devices = pending.devices;
                writeSelfhostState(current);
            } else if (current.machine.crypto.keyVersion !== pending.keyVersion) {
                throw new Error('self-host key version changed during revocation; refusing to overwrite it');
            }

            // The host watches this atomic state file and hot-reloads keys.
            // Restarting the service here also restarts the relay; that can cut
            // off grant publication after clients have already been revoked,
            // stranding every remaining device on the previous generation.
            await new Promise((resolve) => setTimeout(resolve, 2500));
            const uploaded = await api(base, `/v1/selfhost/machines/${encodeURIComponent(current.machine.id)}/grants`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    key_version: pending.keyVersion,
                    grants: pending.grants.map((entry) => ({ device_id: entry.deviceId, grant: entry.grant })),
                }),
            });
            if (!uploaded.response.ok) throw new Error(uploaded.body.error || 'rotated device grants were not published; rerun this command');
            current = readSelfhostState();
            if (current.machine.crypto.keyVersion !== pending.keyVersion) throw new Error('self-host key state changed before rotation completed');
            delete current.machine.crypto.pendingRotation;
            writeSelfhostState(current);
            print(`  ✓ revoked ${pending.revokedDeviceName}; remaining devices received fresh encryption keys`);
        });
        return 0;
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}

async function runSelfhostPair(state, requestedKind = 'native') {
    const base = selfhostControlBase(state);
    const authHeaders = { authorization: `Bearer ${selfhostCredential(state)}` };
    let pending = state.machine.crypto.pendingPair;
    let recoveredPoll;
    if (pending !== undefined && typeof pending.expiresAt === 'number' && pending.expiresAt <= Date.now()) {
        // A claimed relay session remains recoverable after its local display
        // deadline. Poll once before discarding the only copy of its pair key.
        const polled = await api(base, `/v1/selfhost/pair-sessions/${encodeURIComponent(pending.pairId)}`, { headers: authHeaders });
        if (!polled.response.ok) {
            if (polled.response.status !== 403 && polled.response.status !== 404) throw new Error(polled.body.error || 'pair recovery polling failed');
            delete state.machine.crypto.pendingPair;
            writeSelfhostState(state);
            pending = undefined;
        } else if (polled.body.state === 'claimed') recoveredPoll = polled;
        else if (polled.body.state === 'expired') {
            delete state.machine.crypto.pendingPair;
            writeSelfhostState(state);
            pending = undefined;
        }
    }
    if (pending !== undefined && ((pending.deviceKind ?? 'native') !== requestedKind
        || requestedKind === 'native' && typeof pending.pairString !== 'string') && recoveredPoll === undefined) {
        delete state.machine.crypto.pendingPair;
        writeSelfhostState(state);
        pending = undefined;
    }
    if (pending === undefined) {
        const claim = randomBytes(32).toString('base64url');
        const pairSecret = randomBytes(32).toString('base64url');
        const created = await api(base, '/v1/selfhost/pair-sessions', {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ claim, machineSlug: state.machine.id, deviceKind: requestedKind }),
        });
        if (!created.response.ok) throw new Error(created.body.error || `pair session failed (${created.response.status})`);
        const payload = Buffer.from(JSON.stringify({
            v: '2',
            generation: String(state.machine.crypto.keyVersion),
            id: created.body.pair_id,
            claim,
            pair: pairSecret,
            machine: state.machine.id,
            name: state.machine.name ?? 'self-host',
            machinePk: state.machine.crypto.signingPublicKey,
            r: state.relayUrl,
        })).toString('base64url');
        const pairUrl = `muxr://pair?payload=${payload}`;
        let pairString;
        if (requestedKind === 'native') {
            const code = newPairingCode();
            const published = await api(base, `/v1/selfhost/pair-sessions/${encodeURIComponent(created.body.pair_id)}/code`, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({ code_hash: pairingCodeHash(code), payload: sealPairingCodePayload(payload, code) }),
            });
            if (!published.response.ok) throw new Error(published.body.error || 'pairing code publication failed');
            const locator = new URL(state.relayUrl);
            locator.searchParams.set('pair', code);
            pairString = locator.toString();
        }
        pending = {
            pairId: created.body.pair_id,
            pairSecret,
            generation: state.machine.crypto.keyVersion,
            ...(pairString === undefined ? { pairUrl } : { pairString }),
            expiresAt: Date.now() + Number(created.body.expires_in ?? 120) * 1000,
            deviceKind: requestedKind,
        };
        state.machine.crypto.pendingPair = pending;
        writeSelfhostState(state);
    }
    if (pending.grant !== undefined && pending.device !== undefined) {
        const uploaded = await api(base, `/v1/selfhost/pair-sessions/${encodeURIComponent(pending.pairId)}/grant`, {
            method: 'POST', headers: authHeaders, body: JSON.stringify({ grant: pending.grant }),
        });
        if (!uploaded.response.ok) throw new Error(uploaded.body.error || 'grant upload recovery failed');
        state.machine.crypto.devices = [
            ...state.machine.crypto.devices.filter((entry) => entry.deviceId !== pending.device.deviceId),
            pending.device,
        ];
        delete state.machine.crypto.pendingPair;
        writeSelfhostState(state);
        print(`  ✓ paired ${pending.deviceName || 'phone'}`);
        return 0;
    }

    if (recoveredPoll === undefined) {
        print('');
        const browser = pending.deviceKind === 'browser';
        const pairValue = browser ? pending.pairUrl : pending.pairString;
        const payload = browser && typeof pairValue === 'string' ? new URL(pairValue).searchParams.get('payload') : undefined;
        const browserOrigin = publicRelayUrl(state.relayUrl)?.replace(/^wss/, 'https');
        if (browser && browserOrigin && payload) {
            print('Open this secure browser pairing link within two minutes:');
            print(`${browserOrigin}/pair#payload=${payload}`);
            print('The resulting browser access is read-only and expires after eight hours.');
        } else if (process.stdout.isTTY && typeof pairValue === 'string') {
            print(await QRCode.toString(pairValue, { type: 'terminal', small: true }));
        }
        if (typeof pairValue !== 'string') throw new Error('pairing string is unavailable');
        print(browser ? 'Browser pairing string:' : 'Pairing string (expires in two minutes):');
        print(pairValue);
        const pairFile = join(stateDir(), 'pairing-string.txt');
        writeFileSync(pairFile, `${pairValue}\n`, { mode: 0o600 });
        // wl-copy/xclip stay alive as clipboard owners and can freeze setup in a
        // terminal or headless session. macOS pbcopy writes once and exits.
        const clipboard = hostPlatform() === 'darwin'
            ? spawnSync('pbcopy', [], { input: pairValue, timeout: 2_000 })
            : undefined;
        print(clipboard?.status === 0 ? '  ✓ copied pairing string to clipboard' : `  saved pairing string to ${pairFile}`);
        print('Waiting for the device to claim this single-use pairing session…');
    }
    while (true) {
        let polled = recoveredPoll;
        recoveredPoll = undefined;
        if (polled === undefined) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            polled = await api(base, `/v1/selfhost/pair-sessions/${encodeURIComponent(pending.pairId)}`, { headers: authHeaders });
        }
        if (!polled.response.ok) throw new Error(polled.body.error || 'pair polling failed');
        if (polled.body.state === 'pending') continue;
        if (polled.body.state === 'expired') {
            delete state.machine.crypto.pendingPair;
            writeSelfhostState(state);
            throw new Error('pairing session expired; run the command again for a fresh QR');
        }
        if (polled.body.state !== 'claimed') throw new Error(`pairing session ${polled.body.state}`);
        const mailbox = polled.body.mailbox;
        const deviceId = polled.body.deviceId;
        const devicePublicKey = polled.body.devicePublicKey;
        if (typeof mailbox !== 'string' || typeof deviceId !== 'string' || typeof devicePublicKey !== 'string') throw new Error('pairing mailbox is unavailable');
        const plaintext = openV2(mailbox, deriveV2Key(pending.pairSecret, 'client->host'), {
            machineId: state.machine.id,
            senderId: devicePublicKey,
            recipientId: state.machine.id,
            channel: 'pairing',
            streamId: pending.pairId,
            keyVersion: pending.generation,
        }, newV2ReplayTracker());
        const request = JSON.parse(plaintext);
        if (request.devicePublicKey !== devicePublicKey || request.machineSigningPublicKey !== state.machine.crypto.signingPublicKey) {
            const mismatch = [
                request.devicePublicKey !== devicePublicKey && 'device',
                request.machineSigningPublicKey !== state.machine.crypto.signingPublicKey && 'machine',
            ].filter(Boolean).join(' and ');
            throw new Error(`pairing mailbox substitution rejected (${mismatch} key mismatch)`);
        }
        const ingressKey = base64(nacl.randomBytes(32));
        const browser = pending.deviceKind === 'browser';
        const expiresAt = browser ? Date.now() + BROWSER_GRANT_TTL_MS : DURABLE_GRANT_EXPIRES_AT;
        pending.device = {
            deviceId,
            devicePublicKey,
            ingressKey,
            expiresAt: new Date(expiresAt).toISOString(),
            ...(browser ? { kind: 'browser' } : {}),
        };
        pending.deviceName = typeof request.deviceName === 'string' && request.deviceName.trim() !== '' ? request.deviceName.trim() : 'phone';
        pending.grant = JSON.stringify(createDeviceGrant({
            machineId: state.machine.id,
            machineSigningSecretKey: state.machine.crypto.signingSecretKey,
            machineKey: { publicKey: state.machine.crypto.boxPublicKey, secretKey: state.machine.crypto.boxSecretKey },
            deviceId,
            devicePublicKey,
            dataKey: state.machine.crypto.dataKey,
            ingressKey,
            keyVersion: state.machine.crypto.keyVersion,
            expiresAt,
        }));
        state.machine.crypto.pendingPair = pending;
        writeSelfhostState(state);
        return runSelfhostPair(state, pending.deviceKind ?? 'native');
    }
}

export async function runPair(args = []) {
    try {
        const state = readSelfhostState();
        if (state?.machine?.crypto === undefined || typeof selfhostCredential(state) !== 'string') {
            throw new Error('muxr is not set up yet; run `muxr setup` first');
        }
        const browser = args.includes('--browser');
        if (browser && !browserHostingReady()) throw new Error('browser hosting is off. Run `muxr`, choose Set up this machine, and pick Tailscale Serve, Cloudflare, or your own WSS endpoint with browser hosting enabled');
        let healthy = await selfhostRelayHealthy(state);
        if (!healthy) {
            const definition = daemonDefinition('selfhost');
            if (existsSync(definition.path)) await runDaemon(['restart']);
            else if (state.relayLocation !== 'remote') await ensureSelfhostRelay(state.relayPort, state.webRoot, state.bindHost, state.webOrigin, relayDiscovery(state));
            healthy = await selfhostRelayHealthy(state);
        }
        if (!healthy) throw new Error('the relay could not restart; run `muxr doctor` for the exact failing check');
        return await withSelfhostRotationLock(() => runSelfhostPair(state, browser ? 'browser' : 'native'));
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}

export async function runSetup(args = []) {
    const dryRun = args.includes('--dry-run');
    const noAgentConfig = args.includes('--no-agent-config');
    print(`muxr setup${dryRun ? ' (dry run)' : ''}:`);
    try {
        const binary = await ensureHerdr({
            dryRun,
            noInstall: args.includes('--no-install-herdr'),
            installRequested: args.includes('--install-herdr'),
        });
        if (binary) {
            const status = run(binary, ['status']);
            print(`  ${status.ok ? '✓' : 'warn:'} herdr status${status.stdout ? ` — ${status.stdout.split('\n')[0]}` : ''}`);
            await ensureBundledPlugins(binary, dryRun);
            const integrationArgs = ['sync', ...(dryRun ? ['--dry-run'] : []), ...(args.includes('--force') ? ['--force'] : [])];
            if (args.includes('--all')) integrationArgs.push('--all');
            if (noAgentConfig) integrationArgs.push('--no-agent-config');
            if ((await runIntegrations(integrationArgs)) !== 0) throw new Error('integration sync failed');
        }
        if (dryRun) print('  would start/resume hosted device authorization and single-use QR pairing');
        else if ((await runHostedLogin(args)) !== 0) throw new Error('hosted login failed');
        if (!dryRun && process.env.MUXR_SKIP_HOSTED_AUTH !== '1' && (await runAccount('pair')) !== 0) {
            throw new Error('secure device pairing failed');
        }
        await startMuxrDaemon('hosted', args);
        print('  Live Voice is optional; configure it from the muxr Voice plugin pane.');
        print('Ready — open muxr.');
        return 0;
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}

export async function runAccount(command, args = []) {
    try {
        if (command === 'login') {
            const code = await runHostedLogin(args);
            if (code === 0) {
                const definition = daemonDefinition();
                if (existsSync(definition.path)) {
                    const restarted = serviceCommand('restart');
                    if (!restarted.ok) print(`  warn: login succeeded, but the daemon must be restarted manually (${restarted.stderr || restarted.stdout})`);
                }
            }
            return code;
        }
        const auth = loadAuthState();
        if (!auth?.credential || !auth?.controlUrl) {
            if (command === 'logout') {
                print('Already signed out.');
                return 0;
            }
            error('Not signed in — run `muxr login`.');
            return 1;
        }
        if (command === 'whoami') {
            const result = await api(auth.controlUrl, '/v1/session', {
                headers: { authorization: `Bearer ${auth.credential}` },
            });
            if (!result.response.ok) throw new Error(result.body.error || 'hosted session is no longer valid');
            print(`${result.body.account.email} — ${result.body.credential.kind}`);
            return 0;
        }
        if (command === 'logout') {
            await api(auth.controlUrl, '/v1/session', {
                method: 'DELETE',
                headers: { authorization: `Bearer ${auth.credential}` },
            });
            atomicWrite(authPath(), `${JSON.stringify({ version: 1, machine: auth.machine }, null, 2)}\n`);
            print('Signed out. Local machine keys were retained for an explicit re-login or reset.');
            return 0;
        }
        if (command === 'pair') {
            const expectedBrowser = args.includes('--browser');
            if (!auth.machine?.crypto) throw new Error('machine keys are missing; run `muxr login` to register a new machine identity');
            const controlClaim = randomBytes(32).toString('base64url');
            const controlClaimHash = createHash('sha256').update(controlClaim).digest('base64url');
            const pairSecret = randomBytes(32).toString('base64url');
            const result = await api(auth.controlUrl, '/v1/pair-sessions', {
                method: 'POST',
                headers: { authorization: `Bearer ${auth.credential}` },
                body: JSON.stringify({ control_claim_hash: controlClaimHash }),
            });
            if (!result.response.ok || typeof result.body.pair_id !== 'string') {
                throw new Error(result.body.error || `pair request failed (${result.response.status})`);
            }
            const fragment = new URLSearchParams({
                v: '2',
                id: result.body.pair_id,
                claim: controlClaim,
                pair: pairSecret,
                machine: auth.machine.id,
                name: auth.machine.name,
                machinePk: auth.machine.crypto.signingPublicKey,
                generation: String(auth.machine.crypto.keyVersion),
            });
            const pairUrl = `${result.body.verification_uri}#${fragment}`;
            print(`Open: ${pairUrl}`);
            if (process.stdout.isTTY) print(await QRCode.toString(pairUrl, { type: 'terminal', small: true }));
            print('Waiting for the device to claim this single-use pairing session…');
            const expiresAt = Date.now() + Number(result.body.expires_in ?? 300) * 1000;
            while (Date.now() < expiresAt) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                const polled = await api(auth.controlUrl, `/v1/pair-sessions/${encodeURIComponent(result.body.pair_id)}`, {
                    headers: { authorization: `Bearer ${auth.credential}` },
                });
                if (!polled.response.ok) throw new Error(polled.body.error || 'pair polling failed');
                if (polled.body.state === 'pending') continue;
                if (polled.body.state === 'expired') throw new Error('pairing session expired');
                const device = polled.body.device;
                if (polled.body.state !== 'claimed' || typeof device?.id !== 'string' || typeof device.public_key !== 'string') {
                    throw new Error('pairing session returned invalid device metadata');
                }
                const mailbox = polled.body.mailbox;
                if (typeof mailbox !== 'string') throw new Error('pairing mailbox is unavailable');
                const plaintext = openV2(mailbox, deriveV2Key(pairSecret, 'client->host'), {
                    machineId: auth.machine.id,
                    senderId: device.public_key,
                    recipientId: auth.machine.id,
                    channel: 'pairing',
                    streamId: result.body.pair_id,
                    keyVersion: auth.machine.crypto.keyVersion,
                }, newV2ReplayTracker());
                const request = JSON.parse(plaintext);
                if (request.devicePublicKey !== device.public_key || request.machineSigningPublicKey !== auth.machine.crypto.signingPublicKey) {
                    throw new Error('pairing mailbox substitution rejected');
                }
                const ingressKey = base64(nacl.randomBytes(32));
                // Device metadata is client-supplied; browser authority comes
                // only from the machine owner's explicit `muxr pair --browser`.
                const browser = expectedBrowser;
                const expires = browser ? Date.now() + BROWSER_GRANT_TTL_MS : DURABLE_GRANT_EXPIRES_AT;
                const grant = createDeviceGrant({
                    machineId: auth.machine.id,
                    machineSigningSecretKey: auth.machine.crypto.signingSecretKey,
                    machineKey: { publicKey: auth.machine.crypto.boxPublicKey, secretKey: auth.machine.crypto.boxSecretKey },
                    deviceId: device.id,
                    devicePublicKey: device.public_key,
                    dataKey: auth.machine.crypto.dataKey,
                    ingressKey,
                    keyVersion: auth.machine.crypto.keyVersion,
                    expiresAt: expires,
                });
                const uploaded = await api(auth.controlUrl, `/v1/pair-sessions/${encodeURIComponent(result.body.pair_id)}/grant`, {
                    method: 'POST',
                    headers: { authorization: `Bearer ${auth.credential}` },
                    body: JSON.stringify({ grant: JSON.stringify(grant) }),
                });
                if (!uploaded.response.ok) throw new Error(uploaded.body.error || 'grant upload failed');
                auth.machine.crypto.devices = [
                    ...auth.machine.crypto.devices.filter((entry) => entry.deviceId !== device.id),
                    {
                        deviceId: device.id,
                        devicePublicKey: device.public_key,
                        ingressKey,
                        expiresAt: new Date(expires).toISOString(),
                        ...(browser ? { kind: 'browser' } : {}),
                    },
                ];
                atomicWrite(authPath(), `${JSON.stringify(auth, null, 2)}\n`);
                const definition = daemonDefinition();
                if (existsSync(definition.path)) {
                    const restarted = serviceCommand('restart');
                    if (!restarted.ok) print(`  warn: paired, but restart the daemon manually (${restarted.stderr || restarted.stdout})`);
                }
                print(`  ✓ paired ${device.name || 'device'}`);
                return 0;
            }
            throw new Error('pairing session expired');
        }
        throw new Error(`unknown account command: ${command}`);
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}

function entryStatus(path, entry) {
    if (!existsSync(path)) return 'missing';
    const current = readFileSync(path, 'utf8');
    if (entry.kind === 'owned') return hash(current) === entry.hash ? 'current' : 'drifted';
    const block = blockFrom(current);
    return block !== undefined && hash(block) === entry.hash ? 'current' : 'drifted';
}

export async function runDoctor() {
    const checks = [];
    // repair: { label, run } — offered interactively when the check fails.
    const add = (level, name, detail, repair) => checks.push({ level, name, detail, repair });
    const major = Number(process.versions.node.split('.')[0]);
    add(major >= 22 ? 'ok' : 'fail', 'node', `v${process.versions.node}${major >= 22 ? '' : ' — needs >= 22'}`);
    const cliDir = dirname(realpathSync(process.argv[1]));
    const managedMode = daemonMode();
    const runtime = managedMode === 'relay'
        ? existsSync(join(cliDir, 'relay.js')) || existsSync(join(process.cwd(), 'apps', 'relay', 'dist', 'main.js'))
        : existsSync(join(cliDir, 'host.js')) || existsSync(join(process.cwd(), 'apps', 'host', 'dist', 'main.js'));
    add(runtime ? 'ok' : 'fail', managedMode === 'relay' ? 'relay' : 'host', runtime
        ? `${managedMode === 'relay' ? 'relay' : 'host'} runtime present`
        : `missing ${managedMode === 'relay' ? 'relay' : 'host'} runtime; rebuild or reinstall muxr`);
    const binary = managedMode === 'relay' ? undefined : herdrBin();
    if (managedMode === 'relay') {
        add('ok', 'profile', 'shared relay only · Herdr and agent integrations not required');
    } else if (!binary) {
        add('fail', 'herdr', `missing — ${HERDR_INSTALL_HINT}`);
    } else {
        const versionResult = run(binary, ['--version']);
        const version = parseVersion(versionResult.stdout);
        const versionOk = version !== undefined && versionIsCompatible(version);
        add(versionOk ? 'ok' : 'fail', 'herdr', versionOk
            ? versionResult.stdout
            : `${versionResult.stdout || versionResult.stderr || 'unreadable version'} — needs >= ${MIN_HERDR.join('.')}; run \`herdr update\` after reviewing the upgrade`);
        const status = run(binary, ['status']);
        add(status.ok ? 'ok' : 'fail', 'herdr server', status.ok
            ? status.stdout.split('\n')[0] || 'running'
            : `${status.stdout.split('\n')[0] || status.stderr || 'not running'} — start it with \`herdr server\``,
            status.ok ? undefined : { label: 'start the herdr server', run: async () => { await ensureHerdrServer(binary); } });
        const integrations = run(binary, ['integration', 'status']);
        if (integrations.ok) {
            const statuses = parseIntegrationStatus(integrations.stdout);
            const detected = detectedTargets().map((target) => `${target.id}:${statuses.get(target.id) ?? 'unknown'}`);
            const needsSync = detected.some((status) => !status.endsWith(':current'));
            add(needsSync ? 'warn' : 'ok', 'integrations', needsSync
                ? `${detected.join(', ')} — run \`muxr integrations sync\``
                : detected.join(', ') || 'no supported agent CLI detected');
        } else {
            add('warn', 'integrations', `${integrations.stderr || 'status unavailable'} — run \`muxr integrations sync\``);
        }
    }
    const manifest = loadManifest();
    const states = Object.entries(manifest.entries).map(([path, entry]) => `${path.startsWith(`${home()}/`) ? `~/${path.slice(home().length + 1)}` : basename(path)}:${entryStatus(path, entry)}`);
    const drifted = states.filter((state) => state.endsWith(':drifted') || state.endsWith(':missing'));
    add(drifted.length ? 'fail' : states.length ? 'ok' : 'warn', 'managed setup', states.length
        ? (drifted.length ? `${drifted.join(', ')} — run \`muxr integrations sync --force\`` : `${states.length} entries current`)
        : 'not installed — run `muxr setup`',
        drifted.length ? { label: 're-sync managed integration files', run: () => runIntegrations(['sync', '--force']) } : undefined);
    // The pinned-path landmine: a service file whose exec paths no longer
    // resolve dies 203/EXEC at boot while doctor's liveness checks stay green.
    const muxrServicePath = platform() === 'linux'
        ? join(home(), '.config', 'systemd', 'user', 'muxr.service')
        : join(home(), 'Library', 'LaunchAgents', 'com.muxr.host.plist');
    const serviceFiles = [
        ...(platform() === 'linux' || platform() === 'darwin' ? [[muxrServicePath, 'muxr service file']] : []),
        ...(managedMode === 'relay' ? [] : herdrServiceUnitPaths().map((path) => [path, 'herdr service file'])),
    ];
    for (const [servicePath, serviceName] of serviceFiles) {
        if (!existsSync(servicePath)) continue;
        const stale = staleUnitPaths(servicePath);
        if (stale.length === 0) {
            add('ok', serviceName, 'exec paths resolve');
            continue;
        }
        const isMuxr = serviceName === 'muxr service file';
        const repairable = isMuxr || binary !== undefined;
        add('fail', serviceName, `points at missing ${stale.join(', ')} — ${isMuxr
            ? 're-pin it with `muxr daemon install`'
            : repairable ? 'repair it with `muxr doctor`' : `herdr moved; ${HERDR_INSTALL_HINT}`}`,
            repairable
                ? isMuxr
                    ? { label: 're-register the muxr service with current paths', run: () => runDaemon(['install', ...(managedMode === undefined ? [] : ['--mode', managedMode])]) }
                    : { label: 'repair the herdr service file and start herdr', run: async () => { await ensureHerdrServer(binary); } }
                : undefined);
    }
    // Installed-but-disabled: works now, silently gone at the next boot.
    if (platform() === 'linux' && existsSync(muxrServicePath) && env('MUXR_NO_SERVICE_COMMANDS') !== '1') {
        const enabled = run('systemctl', ['--user', 'is-enabled', 'muxr.service']);
        const isEnabled = enabled.stdout === 'enabled' || enabled.stdout === 'enabled-runtime';
        add(isEnabled ? 'ok' : 'fail', 'service enabled', isEnabled
            ? 'muxr.service starts at login'
            : `muxr.service is ${enabled.stdout || 'not enabled'} — it will not survive a reboot; enable it with \`muxr daemon start\``,
            isEnabled ? undefined : { label: 'enable and start the muxr service', run: () => runDaemon(['start']) });
    }
    const selfhost = readSelfhostState();
    if (selfhostStateUnreadable()) {
        add('fail', 'self-host state', `${selfhostPath()} exists but is unreadable (truncated or corrupt) — move it aside with \`mv ${selfhostPath()} ${selfhostPath()}.broken\` only after pairings are backed up; setup refuses to mint a new identity over it`);
    }
    const relayReady = await selfhostRelayHealthy(selfhost);
    const relayDetail = selfhost?.relayLocation === 'remote'
        ? publicRelayUrl(selfhost.relayUrl) ?? 'remote relay'
        : `:${selfhost?.relayPort}`;
    add(selfhost === undefined ? 'warn' : relayReady ? 'ok' : 'fail', 'self-host relay', selfhost === undefined
        ? 'not configured — run muxr setup'
        : relayReady ? `reachable at ${relayDetail}` : `configured at ${relayDetail}, not reachable — restart it with \`muxr daemon restart\``,
        selfhost !== undefined && !relayReady && selfhost.relayLocation !== 'remote'
            // Same recovery runPair uses: the daemon unit owns the relay when
            // installed; only a unitless install has a standalone relay process.
            ? { label: 'restart the self-host relay', run: async () => {
                const definition = daemonDefinition();
                if (existsSync(definition.path)) {
                    if ((await runDaemon(['restart'])) !== 0) throw new Error('muxr daemon restart failed');
                } else {
                    await ensureSelfhostRelay(selfhost.relayPort, selfhost.webRoot, selfhost.bindHost, selfhost.webOrigin);
                }
            } }
            : undefined);
    if (selfhost !== undefined) {
        // Probe the advertised relay for real; 'external' is exempt because NAT
        // hairpin makes self-probing unreliable from the host itself.
        const ingressReady = selfhost.connectionMode === 'external'
            || ((selfhost.connectionMode !== 'cloudflare' || cloudflaredAlive(selfhost.ingress))
                && await advertisedRelayHealthy(selfhost));
        add(ingressReady ? 'ok' : 'fail', 'connection', ingressReady
            ? `${selfhost.connectionMode ?? 'self-host'} · ${publicRelayUrl(selfhost.relayUrl) ?? `local port ${selfhost.relayPort}`}`
            : selfhost.connectionMode === 'cloudflare'
                ? 'Cloudflare tunnel is not running; run `muxr` to restore it and pair the new endpoint'
                : `advertised relay ${publicRelayUrl(selfhost.relayUrl) ?? `on local port ${selfhost.relayPort}`} is not reachable — restart with \`muxr daemon restart\` or reconfigure with \`muxr\``);
        const hostRunning = daemonIsRunning();
        const hostAuthenticated = selfhost.relayLocation !== 'remote' || await remoteHostOnline(selfhost);
        add(hostRunning && hostAuthenticated ? 'ok' : 'fail', managedMode === 'relay' ? 'relay service' : 'host service',
            !hostRunning ? 'not running — start it with `muxr daemon start`'
                : hostAuthenticated ? 'running and authenticated'
                : 'running but not authenticated with the shared relay — restart it with `muxr daemon restart`',
            !hostRunning ? { label: 'start and enable the muxr service', run: () => runDaemon(['start']) } : undefined);
        const devices = selfhost.machine?.crypto?.devices;
        if (Array.isArray(devices)) {
            add('ok', 'paired devices', devices.length === 0
                ? 'none yet — pair a phone with `muxr pair`'
                : `${devices.length} paired`);
        }
        if (selfhost.relayLocation === 'remote' && typeof selfhost.credentialExpiresAt === 'string') {
            const days = Math.ceil((Date.parse(selfhost.credentialExpiresAt) - Date.now()) / (24 * 60 * 60_000));
            add(days <= 30 ? 'warn' : 'ok', 'machine credential', days <= 0
                ? 'expired · create a fresh enrollment on the shared relay server'
                : `${days} day${days === 1 ? '' : 's'} remaining · create a fresh enrollment before expiry`);
        }
        if (selfhost.webEnabled === true) add(ingressReady ? 'ok' : 'warn', 'web client', ingressReady
            ? `${publicRelayUrl(selfhost.relayUrl)?.replace(/^ws/, 'http') ?? 'configured'} · read-only browser grants expire after eight hours`
            : 'configured but unreachable until the tunnel is restored');
    }
    if (hasPendingRemoteConnect()) add('fail', 'pending enrollment', 'run `muxr` and choose Resume remote connection');
    const width = Math.max(...checks.map((check) => check.name.length));
    print();
    for (const check of checks) print(`  ${{ ok: 'ok  ', warn: 'warn', fail: 'FAIL' }[check.level]}  ${check.name.padEnd(width)}  ${check.detail}`);
    const failures = checks.filter((check) => check.level === 'fail');
    print(failures.length ? `\n${failures.length} blocking problem${failures.length === 1 ? '' : 's'} above.` : '\nmuxr setup checks passed.');
    // Interactive repair: offer only what failed and has a known-safe action;
    // anything else stays a printed remedy. Non-interactive runs report only.
    const repairs = failures.filter((check) => check.repair !== undefined);
    if (repairs.length > 0 && process.stdin.isTTY && process.stdout.isTTY) {
        print('\nRepairs available:');
        for (const check of repairs) print(`  • ${check.repair.label}`);
        if (await askVisible(`Run ${repairs.length === 1 ? 'this repair' : `these ${repairs.length} repairs`} now? [y/N] `)) {
            for (const check of repairs) {
                print(`  → ${check.repair.label}`);
                try {
                    const code = await check.repair.run();
                    if (typeof code === 'number' && code !== 0) print(`  warn: repair for "${check.name}" did not finish cleanly`);
                } catch (cause) {
                    print(`  warn: repair for "${check.name}" failed: ${cause instanceof Error ? cause.message : String(cause)}`);
                }
            }
            print('Repairs finished — rerun `muxr doctor` to confirm.');
        }
    }
    return failures.length ? 1 : 0;
}
