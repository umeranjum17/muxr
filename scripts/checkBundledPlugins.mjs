/**
 * Validate every bundled plugin the same way `muxr plugin check` does.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
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
const expectedShortcuts = `${JSON.stringify(bundledShortcutData(), null, 2)}\n`;
if (readFileSync(bakedShortcutsPath, 'utf8') !== expectedShortcuts) {
    process.stderr.write('FAIL bundledShortcuts.json is stale; run the Expo config or update it from bundled manifests\n');
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

const guardedFiles = [join(root, 'apps/mobile/sources/plugins/primitiveRegistry.tsx')];
const realtimeState = join(root, 'apps/mobile/sources/realtime/realtimeSessionState.ts');
function collect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) collect(path);
        else if (/\.(ts|tsx)$/.test(entry.name)) guardedFiles.push(path);
    }
}
collect(join(root, 'apps/mobile/sources/plugins/primitives'));
const forbidden = [
    ['Inbox product view', /@\/components\/InboxView/],
    ['product voice module', /@\/voice\//],
    ['direct herdr tree store', /@\/utils\/(herd|herdTree)/],
    ['mobile product session store', /@\/sync\/(storage|agentKinds)/],
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
process.stdout.write(`${plugins.length} bundled plugins ok; ${guardedFiles.length} primitive files guarded\n`);
