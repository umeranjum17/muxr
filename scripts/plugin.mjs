import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';

import { MAX_PLUGIN_CONTEXT_BYTES, MAX_RPC_ARRAY_ENTRIES, MAX_RPC_DISPLAY_BYTES, MAX_RPC_DISPLAY_DEPTH, MAX_RPC_INPUT_BYTES, MAX_RPC_STDOUT_BYTES, capUtf8Bytes, parseManifest, sanitizeDisplayText } from '@muxr/contract';

const id = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
const fail = (message) => { throw new Error(message); };

function muxrHome() {
    return process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr');
}

function selfhostRelayUrl() {
    const path = join(muxrHome(), 'selfhost.json');
    if (!existsSync(path)) return undefined;
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        const url = typeof parsed?.relayUrl === 'string' ? parsed.relayUrl.trim() : '';
        return url || undefined;
    } catch {
        return undefined;
    }
}

function mobilePackageJson() {
    // scripts/ lives at repo-root/scripts in a source checkout, and at
    // package-root/scripts in the packed npm artifact (no apps/mobile).
    const here = fileURLToPath(new URL('.', import.meta.url));
    const candidate = resolve(here, '../apps/mobile/package.json');
    return existsSync(candidate) ? candidate : undefined;
}

// Validation is delegated to the single shared manifest parser from
// @muxr/contract (packages/contract/src/manifest.ts), which is also what the
// host catalog runs, so `muxr plugin check` accepts and rejects exactly what
// the runtime does. Unknown slots/types/nodes are skipped by the parser, not
// fatal; known shapes with invalid fields throw.

export function checkPlugin(path) {
    const root = realpathSync(resolve(path));
    const pluginPath = `${root}/herdr-plugin.toml`;
    const uiPath = `${root}/muxr-ui.json`;
    if (!existsSync(pluginPath)) fail(`${pluginPath}: required file is missing`);
    const pluginText = readFileSync(pluginPath, 'utf8');
    // Deliberately parse only the small identity subset. Multiline values and
    // quoted keys can otherwise hide a second/top-level id from this parser.
    if (pluginText.includes("'''") || pluginText.includes('\"\"\"')) fail(`${pluginPath}: multiline strings are not supported`);
    if (/[\"']id[\"']\s*=/.test(pluginText)) fail(`${pluginPath}: quoted id keys are not supported`);
    let tableStarted = false;
    let pluginId;
    let idCount = 0;
    for (const line of pluginText.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (/^\[\[?[^\]]+\]\]?/.test(trimmed)) { tableStarted = true; continue; }
        const match = trimmed.match(/^id\s*=\s*"([^"\r\n]*)"\s*(?:#.*)?$/);
        if (match) {
            if (!tableStarted) { pluginId = match[1]; idCount += 1; }
            continue;
        }
        if (!tableStarted && /^id\s*=/.test(trimmed)) fail(`${pluginPath}: id must be a simple quoted top-level field`);
    }
    if (idCount !== 1 || !id(pluginId)) fail(`${pluginPath}: id must be exactly one top-level field matching [a-z0-9][a-z0-9._-]{0,63}`);
    if (!existsSync(uiPath)) return { root, pluginId, ui: false, manifest: undefined };
    let manifest;
    let declared;
    try {
        const raw = JSON.parse(readFileSync(uiPath, 'utf8'));
        declared = Array.isArray(raw?.contributions) ? raw.contributions.length : 0;
        manifest = parseManifest(raw);
    }
    catch (error) { fail(`${uiPath}: ${error instanceof Error ? error.message : String(error)}`); }
    if (manifest.pluginId !== pluginId) fail(`${uiPath}.pluginId: must equal ${pluginId}`);
    // Unknown slots/types are skipped at runtime so old apps tolerate new
    // manifests. At author time that silence hides typos, so say it out loud.
    const skipped = declared - manifest.contributions.length;
    if (skipped > 0) process.stderr.write(`warning: ${uiPath}: ${skipped} of ${declared} contributions not recognized (unknown slot or type) and will not render\n`);
    return { root, pluginId, ui: true, manifest };
}


function boundedJson(value, fallback, maxBytes, label) {
    const serialized = value ?? fallback;
    try { JSON.parse(serialized); } catch { fail(`${label} must be valid JSON`); }
    if (Buffer.byteLength(serialized, 'utf8') > maxBytes) fail(`${label} is too large`);
    return serialized;
}

function boundRpcDisplay(value, depth = 0) {
    if (typeof value === 'string') return capUtf8Bytes(sanitizeDisplayText(value), MAX_RPC_DISPLAY_BYTES);
    if (value === null) return null;
    if (depth >= MAX_RPC_DISPLAY_DEPTH) return undefined;
    if (Array.isArray(value)) return value.slice(0, MAX_RPC_ARRAY_ENTRIES).map((entry) => boundRpcDisplay(entry, depth + 1));
    if (typeof value !== 'object') return value;
    const out = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
        const bounded = boundRpcDisplay(entry, depth + 1);
        if (bounded !== undefined) out[key] = bounded;
    }
    return out;
}

function runRpcCall(checked, contributionId, inputJson, contextJson) {
    const rpcs = checked.manifest.contributions.filter((entry) => 'type' in entry && entry.type === 'rpc');
    const target = rpcs.find((entry) => entry.id === contributionId);
    if (!target) {
        const available = rpcs.map((entry) => entry.id).join(', ') || 'none';
        fail(`no rpc contribution ${contributionId} in ${checked.pluginId} (available: ${available})`);
    }
    process.stderr.write(`${checked.pluginId}.${contributionId} (${target.mode ?? 'read'} mode)\n`);
    const serializedInput = boundedJson(inputJson, 'null', MAX_RPC_INPUT_BYTES, '--input');
    if (contextJson !== undefined && (target.context?.length ?? 0) === 0) fail(`${contributionId} does not declare host context`);
    const serializedContext = contextJson === undefined ? undefined : boundedJson(contextJson, '{}', MAX_PLUGIN_CONTEXT_BYTES, '--context');
    const stateDir = mkdtempSync(join(tmpdir(), `muxr-plugin-${checked.pluginId.replace(/[^a-z0-9._-]/gi, '_')}-`));
    let child;
    try {
        child = spawnSync(process.execPath, [join(checked.root, target.entry), target.method], {
            env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                ...(process.env.MUXR_HOME ? { MUXR_HOME: process.env.MUXR_HOME } : {}),
                MUXR_PLUGIN_ID: checked.pluginId,
                MUXR_PLUGIN_STATE_DIR: stateDir,
                ...(serializedContext === undefined ? {} : { MUXR_PLUGIN_CONTEXT_JSON: serializedContext }),
            },
            input: serializedInput,
            timeout: 30_000,
            maxBuffer: MAX_RPC_STDOUT_BYTES + 1024,
            encoding: 'utf8',
        });
    } finally {
        rmSync(stateDir, { recursive: true, force: true });
    }
    if (child.error) fail(child.error.signal === 'SIGTERM' ? 'plugin call timed out after 30s' : child.error.message);
    const stdout = child.stdout ?? '';
    if (Buffer.byteLength(stdout, 'utf8') > MAX_RPC_STDOUT_BYTES) fail(`plugin ${checked.pluginId}.${target.method} output exceeded ${MAX_RPC_STDOUT_BYTES} bytes`);
    if (child.status !== 0) fail(((child.stderr ?? '').trim() || `plugin exited with code ${child.status}`).slice(0, 500));
    let result;
    try { result = JSON.parse(stdout); }
    catch { fail(`plugin ${checked.pluginId}.${target.method} returned invalid JSON`); }
    process.stdout.write(`${JSON.stringify(boundRpcDisplay(result), null, 2)}\n`);
    return 0;
}

export function runPlugin(command, args = []) {
    if (command === 'call') {
        const option = (name) => {
            const index = args.indexOf(name);
            if (index !== -1) {
                if (index === args.length - 1) fail(`${name} requires a JSON value`);
                return args[index + 1];
            }
            const inline = args.find((arg) => arg.startsWith(`${name}=`));
            return inline?.slice(name.length + 1);
        };
        const positional = [];
        for (let index = 0; index < args.length; index += 1) {
            if (args[index] === '--input' || args[index] === '--context') { index += 1; continue; }
            if (args[index].startsWith('--input=') || args[index].startsWith('--context=')) continue;
            positional.push(args[index]);
        }
        const [path, contributionId] = positional;
        if (!path || !contributionId) fail('muxr plugin call requires a path and a contribution id');
        return runRpcCall(checkPlugin(path), contributionId, option('--input'), option('--context'));
    }
    const web = args.includes('--web');
    const path = args.find((arg) => arg !== '--web');
    if (!path) fail(`muxr plugin ${command} requires a path or name`);
    if (web && command !== 'dev') fail(`--web is only valid with muxr plugin dev`);
    if (command === 'create') {
        const root = resolve(path);
        if (existsSync(root)) fail(`${root}: already exists`);
        mkdirSync(root, { recursive: true });
        const here = fileURLToPath(new URL('.', import.meta.url));
        const template = existsSync(resolve(here, 'plugins/example-ui'))
            ? resolve(here, 'plugins/example-ui')
            : resolve(here, '../plugins/example-ui');
        cpSync(template, root, { recursive: true });
        const slug = basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '') || 'plugin';
        const pluginId = `local.${slug}`.slice(0, 64);
        for (const file of [`${root}/herdr-plugin.toml`, `${root}/muxr-ui.json`, `${root}/README.md`]) {
            const text = readFileSync(file, 'utf8')
                .replaceAll('example.muxr-ui', pluginId)
                .replaceAll('Example muxr UI', basename(root))
                .replaceAll('example.list', `${slug}.list`)
                .replaceAll('example.save', `${slug}.save`)
                .replaceAll('./plugins/example-ui', '.')
                .replaceAll('"Example"', JSON.stringify(basename(root)))
                .replace(/The package is also the starter template `muxr plugin create` copies, and it /, 'It ');
            writeFileSync(file, text);
        }
        process.stdout.write(`created ${root} (${pluginId})\n`);
        return 0;
    }
    const checked = checkPlugin(path);
    process.stdout.write(`✓ ${checked.pluginId}: ${checked.ui ? 'backend + muxr UI' : 'backend only'}\n`);
    if (command === 'check') return 0;
    if (command !== 'dev') fail(`unknown plugin command: ${command}`);
    const result = spawnSync(process.env.HERDR_BIN?.trim() || 'herdr', ['plugin', 'link', checked.root, '--enabled'], { stdio: 'inherit' });
    if (result.status !== 0) return result.status ?? 1;
    process.stdout.write(`linked ${basename(checked.root)}; reconnect muxr after manifest edits\n`);
    if (!web) return 0;

    const packageJson = mobilePackageJson();
    if (!packageJson) {
        process.stderr.write('muxr plugin dev --web needs a source checkout (apps/mobile/package.json not found)\n');
        return 1;
    }
    const relayUrl = selfhostRelayUrl();
    if (!relayUrl) {
        process.stderr.write('muxr plugin dev --web: no self-host relay URL; run `muxr self-host` first\n');
        return 1;
    }
    process.stdout.write(`starting web client against ${relayUrl}\n`);
    const mobileRoot = dirname(packageJson);
    const expo = spawnSync('npx', ['expo', 'start', '--web'], {
        cwd: mobileRoot,
        stdio: 'inherit',
        env: {
            ...process.env,
            EXPO_PUBLIC_MUXR_RELAY_URL: relayUrl,
            EXPO_PUBLIC_MUXR_MODE: 'selfhost',
        },
    });
    return expo.status ?? 1;
}
