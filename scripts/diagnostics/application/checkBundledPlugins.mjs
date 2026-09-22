/**
 * muxr ships no bundled Herdr add-ons: every product surface is product code.
 * This proves the retirement stuck -- no add-on folder remains, and no shell
 * code still branches on an id muxr used to bundle -- and keeps the primitive
 * dependency and launcher-shortcut guards that were already here.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const pluginsDir = join(root, 'plugins');
const plugins = existsSync(pluginsDir)
    ? readdirSync(pluginsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(pluginsDir, entry.name, 'herdr-plugin.toml')))
        .map((entry) => entry.name)
        .sort()
    : [];

let failed = 0;
if (plugins.length > 0) {
    process.stderr.write(`FAIL: muxr ships no bundled add-ons, found ${plugins.join(', ')}\n`);
    failed += 1;
} else {
    process.stdout.write('ok  no bundled Herdr add-ons ship\n');
}

// Production shell code must never name an add-on muxr used to bundle: every one
// of those surfaces is product code now. Tests and generated JSON are outside
// this scan, and the third-party plugin catalog legitimately names installed
// plugins rather than bundled ones.
const retiredIds = [
    'muxr.terminal-keys', 'muxr.panes', 'muxr.control', 'muxr.dictation', 'muxr.status',
    'muxr.voice', 'muxr.voice-gemini', 'muxr.voice-openai', 'muxr.voice-codex',
];
const bundledIds = [...retiredIds,
    ...plugins.flatMap((name) => {
        const path = join(pluginsDir, name, 'muxr-ui.json');
        if (!existsSync(path)) return [];
        const value = JSON.parse(readFileSync(path, 'utf8'));
        return typeof value.pluginId === 'string' ? [value.pluginId] : [];
    })];
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
// A retired id stays a real value in two places, and both are about a previous
// release rather than a product branch: the voice adapters name the legacy state
// file setup migrates out of, and the host keeps a retraction list. Those lines
// are a retention record, so the scan ignores them.
const RETENTION_LINE = /RETIRED_PLUGIN_IDS|LEGACY_BUNDLED_PLUGIN_IDS|LEGACY_PLUGIN_IDS/;
// The installed-plugin catalog is the one product surface that identifies
// bundled plugins for grouping and configuration. Keep this exception local.
const catalogScreens = new Set([
    join(root, 'apps/mobile/sources/app/(app)/settings/plugins.tsx'),
]);
for (const path of shellFiles) {
    if (catalogScreens.has(path)) continue;
    const source = readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => !RETENTION_LINE.test(line))
        .join('\n');
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
// The launcher XML is generated from the shortcut list, so it must not drift
// when a product shortcut is renamed. Nothing else compares these files.
const generatedShortcuts = require(join(root, 'apps/mobile/plugins/withAppActions.js'));
const shortcutData = generatedShortcuts.bundledShortcutData();
for (const variant of [
    { file: join(root, 'apps/mobile/android/app/src/main/res/xml/shortcuts.xml'), scheme: 'muxr', target: 'com.trymuxr.app' },
    { file: join(root, 'apps/mobile/android/app/src/main/res/xml/dev_shortcuts.xml'), scheme: 'muxr-dev', target: 'app.muxr.local.dev' },
]) {
    const xml = readFileSync(variant.file, 'utf8');
    for (const shortcut of shortcutData) {
        const resourceName = shortcut.id.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
        if (!xml.includes(`android:shortcutId="${shortcut.id}"`)) {
            process.stderr.write(`FAIL ${variant.file} is stale: it does not declare shortcut ${shortcut.id}\n`);
            failed += 1;
        }
        if (!xml.includes(`android:data="${variant.scheme}://shortcut/${shortcut.id}"`)) {
            process.stderr.write(`FAIL ${variant.file} is stale: ${shortcut.id} deep link does not match its id\n`);
            failed += 1;
        }
        if (!xml.includes(`@string/muxr_shortcut_${resourceName}_short`)) {
            process.stderr.write(`FAIL ${variant.file} is stale: ${shortcut.id} does not reference its generated strings\n`);
            failed += 1;
        }
        if (!xml.includes(`android:targetPackage="${variant.target}"`)) {
            process.stderr.write(`FAIL ${variant.file} must target ${variant.target}\n`);
            failed += 1;
        }
    }
    const declared = [...xml.matchAll(/android:shortcutId="([^"]+)"/g)].map((match) => match[1]).sort();
    const expected = shortcutData.map((shortcut) => shortcut.id).sort();
    if (declared.join(',') !== expected.join(',')) {
        process.stderr.write(`FAIL ${variant.file} declares ${declared.join(',')} but the shortcut list is ${expected.join(',')}\n`);
        failed += 1;
    }
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

process.stdout.write(`no bundled add-ons; ${guardedFiles.length} primitive files guarded\n`);
