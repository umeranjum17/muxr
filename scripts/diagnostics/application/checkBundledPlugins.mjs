/**
 * Validate every bundled plugin the same way `muxr plugin check` does.
 */
import { existsSync, readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const pluginsDir = join(root, 'plugins');
const plugins = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(pluginsDir, entry.name, 'herdr-plugin.toml')))
    .map((entry) => entry.name)
    .sort();

if (plugins.length === 0) {
    process.stderr.write('FAIL: no bundled plugins found\n');
    process.exit(1);
}

let failed = 0;
for (const name of plugins) {
    const result = spawnSync(process.execPath, [join(root, 'scripts/cli.mjs'), 'plugin', 'check', join('plugins', name)], {
        encoding: 'utf8',
        cwd: root,
    });
    if (result.status !== 0) {
        process.stderr.write(`FAIL plugins/${name}\n${result.stderr || result.stdout}\n`);
        failed += 1;
    } else {
        process.stdout.write(`ok  plugins/${name}\n`);
    }
}

if (failed > 0) process.exit(1);

// Bundled manifests use the public API; production shell code must never branch
// on one of their ids. Tests and generated JSON are intentionally outside this scan.
const bundledIds = plugins.flatMap((name) => {
    const path = join(pluginsDir, name, 'muxr-ui.json');
    if (!existsSync(path)) return [];
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return typeof value.pluginId === 'string' ? [value.pluginId] : [];
});
const shellFiles = [];
function collectShell(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) collectShell(path);
        else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)) shellFiles.push(path);
    }
}
collectShell(join(root, 'apps/mobile/sources'));
collectShell(join(root, 'apps/host/src'));
for (const path of shellFiles) {
    const source = readFileSync(path, 'utf8');
    for (const pluginId of bundledIds) {
        if (source.includes(pluginId)) {
            process.stderr.write(`FAIL bundled plugin caste guard: ${path} names ${pluginId}\n`);
            failed += 1;
        }
    }
}

const require = createRequire(import.meta.url);
const { bundledShortcutData, shortcutResources } = require(join(root, 'apps/mobile/plugins/withAppActions.js'));
const bakedShortcutsPath = join(root, 'apps/mobile/sources/plugins/bundledShortcuts.json');
const nativeShortcutsPath = join(root, 'apps/mobile/android/app/src/main/res/xml/shortcuts.xml');
const expectedShortcuts = `${JSON.stringify(bundledShortcutData(), null, 2)}\n`;
if (readFileSync(bakedShortcutsPath, 'utf8') !== expectedShortcuts) {
    process.stderr.write('FAIL bundledShortcuts.json is stale; run the Expo config or update it from bundled manifests\n');
    failed += 1;
}
const nativeShortcuts = readFileSync(nativeShortcutsPath, 'utf8');
if (!nativeShortcuts.includes('android:targetPackage="com.trymuxr.app"') || /android:targetPackage="@/.test(nativeShortcuts)) {
    process.stderr.write('FAIL Android launcher shortcut targetPackage must be the literal Play package id\n');
    failed += 1;
}
if (/<capability(?:-binding)?\b/.test(nativeShortcuts) || nativeShortcuts.includes('actions.intent.')) {
    process.stderr.write('FAIL Android launcher shortcuts must not declare Play-blocked App Actions capabilities\n');
    failed += 1;
}
const localizedShortcutFixture = [{
    shortcutId: 'example.open', resourceName: 'example_open', label: 'Open', longLabel: 'Open example', synonyms: ['Open'],
    localized: { es: { label: 'Abrir', longLabel: 'Abrir ejemplo', synonyms: ['Abrir', 'iniciar'] } },
    action: { type: 'capability', name: 'example.open' },
}];
const localizedXml = shortcutResources(localizedShortcutFixture, 'es');
const localizedAliases = bundledShortcutData(localizedShortcutFixture)[0]?.aliases ?? [];
if (!localizedXml.includes('>Abrir<') || !localizedXml.includes('>iniciar<') || !localizedAliases.includes('iniciar')) {
    process.stderr.write('FAIL localized shortcut resources/aliases are incomplete\n');
    failed += 1;
}

const guardedFiles = [join(root, 'apps/mobile/sources/plugins/presentation/primitiveRegistry.tsx')];
const realtimeState = join(root, 'apps/mobile/sources/conversation/application/realtimeSessionState.ts');
function collect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) collect(path);
        else if (/\.(ts|tsx)$/.test(entry.name)) guardedFiles.push(path);
    }
}
collect(join(root, 'apps/mobile/sources/plugins/presentation/primitives'));
const forbidden = [
    ['Inbox product view', /@\/components\/InboxView/],
    ['product voice module', /@\/voice\//],
    ['direct herdr tree store', /@\/utils\/(herd|herdTree)/],
    ['mobile product session store', /@\/(?:sync|catalog)\/(?:store|application\/storage|domain\/agentKinds)/],
    ['direct herdr tree request', /herdr\.tree|useHerdrTree/],
    ['preview product module', /from\s+['"][^'"]*(?:@\/preview|\/preview\/)[^'"]*['"]/],
    ['preview product primitive', /PreviewHeader|url-chip/],
    ['direct preview transport request', /preview\.(?:list|attach)/],
];
for (const path of guardedFiles) {
    const source = readFileSync(path, 'utf8');
    for (const [label, pattern] of forbidden) {
        if (pattern.test(source)) {
            process.stderr.write(`FAIL primitive dependency guard: ${path} imports ${label}\n`);
            failed += 1;
        }
    }
}
const realtimeStateSource = readFileSync(realtimeState, 'utf8');
if (/VoiceBubble|VoiceOrb|VoiceConversation|voiceState/.test(realtimeStateSource)) {
    process.stderr.write(`FAIL primitive dependency guard: realtime singleton imports product Voice presentation\n`);
    failed += 1;
}
if (failed > 0) process.exit(1);

const codeManifest = JSON.parse(readFileSync(join(pluginsDir, 'code', 'muxr-ui.json'), 'utf8'));
const codeRpc = (id) => codeManifest.contributions.find((contribution) => contribution.id === id);
if (codeRpc('files.nav')?.contentContributionId !== 'files.browse') {
    process.stderr.write('FAIL files.nav does not open files.browse\n');
    process.exit(1);
}
for (const id of ['files.list', 'files.read']) {
    const context = codeRpc(id)?.context;
    if (!Array.isArray(context) || !context.includes('sessions')) {
        process.stderr.write(`FAIL ${id} must request sessions context for Files navigation\n`);
        process.exit(1);
    }
}
const repo = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
if (repo.status !== 0 || repo.stdout.trim() === '') {
    process.stderr.write('FAIL could not resolve the Files flow repository\n');
    process.exit(1);
}
const repoRoot = repo.stdout.trim();
const filesEntry = join(pluginsDir, 'code', codeRpc('files.list').entry);
const callFiles = (method, input, context) => spawnSync(process.execPath, [filesEntry, method], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify(input),
    env: { ...process.env, MUXR_PLUGIN_CONTEXT_JSON: context },
    timeout: 20_000,
});
const denied = callFiles('list', { root: repoRoot }, '{}');
if (denied.status === 0 || !/unknown repository/.test(`${denied.stderr}${denied.stdout}`)) {
    process.stderr.write('FAIL files.list opened a repo without sessions context\n');
    process.exit(1);
}
const context = JSON.stringify({ sessions: [{ cwd: repoRoot }] });
const listed = callFiles('list', { root: repoRoot }, context);
if (listed.status !== 0) {
    process.stderr.write(`FAIL files.list through files.nav context\n${listed.stderr || listed.stdout}\n`);
    process.exit(1);
}
const tree = JSON.parse(listed.stdout);
if (tree.root !== repoRoot) {
    process.stderr.write('FAIL files.list did not authorize the session repository\n');
    process.exit(1);
}
const leaf = 'plugins/code/README.md';
const preview = callFiles('read', { root: repoRoot, path: leaf }, context);
if (preview.status !== 0) {
    process.stderr.write(`FAIL files.read through files.nav context\n${preview.stderr || preview.stdout}\n`);
    process.exit(1);
}
const body = JSON.parse(preview.stdout);
if (body.name !== 'README.md' || body.path !== leaf || typeof body.body !== 'string' || body.body === '') {
    process.stderr.write('FAIL files.read did not return the selected leaf\n');
    process.exit(1);
}

process.stdout.write(`${plugins.length} bundled plugins ok; ${guardedFiles.length} primitive files guarded; files.nav list/read flow ok\n`);

// Drive the actual Panes plugin: terminal apps are launchers, shell and setup
// inventories stay out of Tools, and shells remain reachable through Panes.
const toolsScratch = mkdtempSync(join(tmpdir(), 'muxr-tools-flow-'));
try {
    const fixtureHerdr = join(toolsScratch, 'herdr');
    writeFileSync(fixtureHerdr, `#!/usr/bin/env node
const [area] = process.argv.slice(2);
const panes = Array.from({length: 80}, (_, i) => ({pane_id: 'shell-' + i, workspace_id: 'work', cwd: '/work'}));
const plugins = [
 {plugin_id:'example.browser', name:'Terminal Browser', enabled:true, actions:[{id:'open', title:'Open', contexts:['global']}]},
 {plugin_id:'example.code', name:'Terminal Code', enabled:true, actions:[{id:'open', title:'Open', contexts:['global']}]},
 {plugin_id:'example.admin', name:'Setup', enabled:true, panes:[{id:'setup', title:'Configure'}], actions:[{id:'setup', contexts:['pane']}]},
 {plugin_id:'example.disabled', name:'Disabled', enabled:false, actions:[{id:'open', contexts:['global']}]}
];
let result = {workspaces:[{workspace_id:'work',label:'Work'}]};
if (area === 'plugin') result = {plugins};
if (area === 'pane') result = {panes};
process.stdout.write(JSON.stringify({result}));
`, { mode: 0o700 });
    const invokePanes = (method) => {
        const result = spawnSync(process.execPath, [join(pluginsDir, 'panes', 'panes.mjs'), method], {
            encoding: 'utf8', input: '{}', timeout: 20_000,
            env: { ...process.env, HERDR_BIN_PATH: fixtureHerdr },
        });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout).items;
    };
    assert.deepEqual(invokePanes('tools').map((item) => item.title), ['Terminal Browser', 'Terminal Code']);
    assert.equal(invokePanes('list').length, 80);
    process.stdout.write('Tools app discovery and separate Panes flow ok\n');
} finally {
    rmSync(toolsScratch, { recursive: true, force: true });
}
