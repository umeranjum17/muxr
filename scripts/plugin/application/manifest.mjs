import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';

import { MAX_PLUGIN_CONTEXT_BYTES, MAX_RPC_INPUT_BYTES, MAX_RPC_STDOUT_BYTES, boundRpcDisplay, parseManifest } from '@muxr/contract';
import { isPluginId } from '../domain/dist/index.js';
import {
    bundledPluginsRoot,
    mobilePackageJson,
    packedCliRoot,
    pluginDocsPath,
    pluginReferencePath,
    pluginSkillPath,
} from '../infrastructure/paths.mjs';

const id = (value) => isPluginId(value);
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

function printPluginDocs() {
    const guide = pluginDocsPath();
    const skill = pluginSkillPath();
    const reference = pluginReferencePath();
    if (guide === undefined || skill === undefined || reference === undefined) {
        fail('plugin documentation is missing from this muxr install');
    }
    process.stdout.write(`Plugin guide: ${guide}\n`);
    process.stdout.write(`Agent skill: ${skill}\n`);
    process.stdout.write(`Plugin reference: ${reference}\n`);
    return 0;
}

function pluginDestination(path) {
    const target = resolve(path);
    let ancestor = dirname(target);
    while (!existsSync(ancestor)) {
        const parent = dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
    }
    const canonical = resolve(realpathSync(ancestor), relative(ancestor, target));
    const packed = packedCliRoot();
    if (packed !== undefined && (canonical === packed || canonical.startsWith(`${packed}${sep}`))) {
        fail('plugin destination must be outside the npm package so updates cannot remove it');
    }
    return { target, canonical };
}

function localPluginId(target, canonical = target) {
    const slug = basename(target).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '') || 'plugin';
    const suffix = createHash('sha256').update(canonical).digest('hex').slice(0, 8);
    return `local.${slug.slice(0, 48)}-${suffix}`;
}

function cloneBundledPlugin(pluginId, destination) {
    if (!id(pluginId)) fail('muxr plugin clone requires a valid bundled plugin id');
    const plugins = bundledPluginsRoot();
    if (plugins === undefined) fail('bundled plugins are missing from this muxr install');
    const source = readdirSync(plugins, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(plugins, entry.name))
        .find((root) => existsSync(join(root, 'herdr-plugin.toml'))
            && readFileSync(join(root, 'herdr-plugin.toml'), 'utf8').match(/^id\s*=\s*"([^"]+)"/m)?.[1] === pluginId);
    if (!source) fail(`no bundled plugin ${pluginId}`);
    const { target, canonical } = pluginDestination(destination ?? `${basename(source)}-custom`);
    if (existsSync(target)) fail(`${target}: already exists`);
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    const clonedId = localPluginId(target, canonical);
    try {
        cpSync(source, temporary, { recursive: true });
        const pluginPath = join(temporary, 'herdr-plugin.toml');
        writeFileSync(pluginPath, readFileSync(pluginPath, 'utf8')
            .replace(/^id\s*=\s*"[^"]+"/m, `id = "${clonedId}"`)
            .replace(/^name\s*=\s*"([^"]+)"/m, (_line, name) => `name = "${name} custom"`));
        const uiPath = join(temporary, 'muxr-ui.json');
        if (existsSync(uiPath)) {
            const manifest = JSON.parse(readFileSync(uiPath, 'utf8'));
            manifest.pluginId = clonedId;
            writeFileSync(uiPath, `${JSON.stringify(manifest, null, 2)}\n`);
        }
        const readmePath = join(temporary, 'README.md');
        if (existsSync(readmePath)) writeFileSync(readmePath, readFileSync(readmePath, 'utf8').replaceAll(pluginId, clonedId));
        const voiceImport = /from '\.\.\/voice\/([^']+)'/g;
        for (const name of ['stream.mjs', 'rpc.mjs']) {
            const path = join(temporary, name);
            if (!existsSync(path)) continue;
            let text = readFileSync(path, 'utf8');
            const needed = [...text.matchAll(voiceImport)].map((match) => match[1]);
            if (needed.length === 0) continue;
            for (const relativePath of new Set(needed)) {
                const destName = relativePath.split('/').pop();
                cpSync(join(plugins, 'voice', relativePath), join(temporary, destName));
                text = text.replaceAll(`from '../voice/${relativePath}'`, `from './${destName}'`);
            }
            writeFileSync(path, text);
        }
        checkPlugin(temporary);
        renameSync(temporary, target);
    } finally {
        rmSync(temporary, { recursive: true, force: true });
    }
    process.stdout.write(`cloned ${pluginId} -> ${target} (${clonedId})\n`);
    process.stdout.write('edit it, then replace safely:\n');
    process.stdout.write(`  herdr plugin disable ${pluginId}\n`);
    process.stdout.write(`  muxr plugin dev ${target}\n`);
    process.stdout.write(`if linking fails, restore with: herdr plugin enable ${pluginId}\n`);
    return 0;
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
    if (command === 'docs') {
        if (args.length !== 0) fail('muxr plugin docs takes no arguments');
        return printPluginDocs();
    }
    if (command === 'clone') {
        if (!args[0] || args.length > 2) fail('muxr plugin clone requires a plugin id and optional destination');
        return cloneBundledPlugin(args[0], args[1]);
    }
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
        const { target: root, canonical } = pluginDestination(path);
        if (existsSync(root)) fail(`${root}: already exists`);
        mkdirSync(root, { recursive: true });
        const title = basename(root);
        const pluginId = localPluginId(root, canonical);
        writeFileSync(join(root, 'herdr-plugin.toml'), [
            `id = "${pluginId}"`,
            `name = ${JSON.stringify(title)}`,
            'version = "0.1.0"',
            'min_herdr_version = "0.8.0"',
            `description = ${JSON.stringify(`${title} muxr plugin`)}`,
            'platforms = ["linux", "macos", "windows"]',
            '',
        ].join('\n'));
        writeFileSync(join(root, 'muxr-ui.json'), `${JSON.stringify({
            schemaVersion: 1,
            pluginId,
            contributions: [
                {
                    slot: 'settings.items', id: 'settings', type: 'settings-item', label: title,
                    subtitle: 'Open this plugin', icon: 'extension-puzzle-outline',
                    action: { type: 'screen', contributionId: 'settings-screen' },
                },
                {
                    slot: 'navigation.content', id: 'settings-screen', type: 'screen', title,
                    children: [
                        { type: 'text', text: 'This native screen comes from muxr-ui.json.' },
                        { type: 'row', title: 'Status', value: 'It works' },
                    ],
                },
            ],
        }, null, 2)}\n`);
        writeFileSync(join(root, 'README.md'), `# ${title}\n\nA minimal UI-only muxr plugin created by \`muxr plugin create\`.\n\n- **Phone:** one Settings item opening a native declarative screen.\n- **Host:** no executable backend or data access.\n- **Offline:** hidden until the host reconnects.\n- **Develop:** \`muxr plugin dev .\`\n- **Remove:** \`herdr plugin unlink ${pluginId}\`\n`);
        checkPlugin(root);
        process.stdout.write(`created ${root} (${pluginId})\n`);
        return 0;
    }
    const checked = checkPlugin(path);
    process.stdout.write(`✓ ${checked.pluginId}: ${checked.ui ? 'muxr UI manifest' : 'Herdr only'}\n`);
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
