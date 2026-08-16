// Expo config plugin: Google Assistant App Actions.
//
// Shortcuts come from the bundled plugins' own muxr-ui.json, so adding a voice
// shortcut is a manifest edit rather than an Android change. Static shortcuts
// are baked at build time by Android's design. Runtime-installed plugins use
// the same contribution through ShortcutManagerCompat for launcher shortcuts.
const { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync, unlinkSync } = require('fs');
const { join } = require('path');
const { withAndroidManifest, withDangerousMod, AndroidConfig } = require('expo/config-plugins');

const PLUGINS_DIR = join(__dirname, '..', '..', '..', 'plugins');
const BAKED_JS = join(__dirname, '..', 'sources', 'plugins', 'bundledShortcuts.json');

function textVariants(value) {
    if (typeof value === 'string') return { default: value, translations: {} };
    return { default: value.default, translations: value.translations ?? {} };
}

function translated(value, locale) {
    const variants = textVariants(value);
    if (locale === undefined) return variants.default;
    const exact = Object.entries(variants.translations).find(([tag]) => tag.toLowerCase() === locale.toLowerCase())?.[1];
    if (exact !== undefined) return exact;
    const base = locale.split('-')[0].toLowerCase();
    return Object.entries(variants.translations).find(([tag]) => tag.toLowerCase() === base)?.[1] ?? variants.default;
}

function dedupe(values) {
    const seen = new Set();
    return values.flatMap((value) => {
        const text = String(value).trim();
        const key = text.toLocaleLowerCase('en-US');
        if (text === '' || seen.has(key)) return [];
        seen.add(key);
        return [text];
    });
}

function bundledShortcuts() {
    if (!existsSync(PLUGINS_DIR)) return [];
    return readdirSync(PLUGINS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
            const manifestPath = join(PLUGINS_DIR, entry.name, 'muxr-ui.json');
            if (!existsSync(manifestPath)) return [];
            let manifest;
            try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { return []; }
            const pluginId = manifest.pluginId;
            return (manifest.contributions ?? [])
                .filter((contribution) => contribution.slot === 'shortcuts')
                .map((contribution) => {
                    const locales = [...new Set([contribution.label, contribution.longLabel, ...(contribution.synonyms ?? [])]
                        .filter(Boolean).flatMap((value) => Object.keys(textVariants(value).translations)))].sort();
                    const at = (locale) => {
                        const label = translated(contribution.label, locale);
                        return {
                            label,
                            longLabel: translated(contribution.longLabel ?? contribution.label, locale),
                            synonyms: dedupe([label, ...(contribution.synonyms ?? []).map((value) => translated(value, locale))]),
                        };
                    };
                    return {
                        shortcutId: `${pluginId}.${contribution.id}`,
                        resourceName: `${pluginId}.${contribution.id}`.replace(/[^a-z0-9]+/gi, '_').toLowerCase(),
                        ...at(undefined),
                        localized: Object.fromEntries(locales.map((locale) => [locale, at(locale)])),
                        action: contribution.action,
                    };
                });
        });
}

function escapeXml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function bundledShortcutData(shortcuts = bundledShortcuts()) {
    return shortcuts.map((shortcut) => ({
        id: shortcut.shortcutId,
        action: shortcut.action,
        // OPEN_APP_FEATURE puts the spoken synonym in the URL, not shortcutId.
        aliases: dedupe([
            ...shortcut.synonyms,
            ...Object.values(shortcut.localized).flatMap((value) => value.synonyms),
        ]),
    }));
}

function writeStable(path, next) {
    if (existsSync(path) && readFileSync(path, 'utf8') === next) return;
    writeFileSync(path, next);
}

function writeBakedJs(shortcuts) {
    writeStable(BAKED_JS, `${JSON.stringify(bundledShortcutData(shortcuts), null, 2)}\n`);
}

function androidLocaleQualifier(locale) {
    const parts = locale.split('-');
    if (parts.length === 1) return parts[0].toLowerCase();
    return `b+${parts.map((part, index) => index === 0 ? part.toLowerCase() : part).join('+')}`;
}

function shortcutResources(shortcuts, locale) {
    const strings = shortcuts.flatMap((shortcut) => {
        const value = locale === undefined ? shortcut : shortcut.localized[locale] ?? shortcut;
        return [
            `    <string name="muxr_shortcut_${shortcut.resourceName}_short">${escapeXml(value.label)}</string>`,
            `    <string name="muxr_shortcut_${shortcut.resourceName}_long">${escapeXml(value.longLabel)}</string>`,
            `    <string-array name="muxr_shortcut_${shortcut.resourceName}_synonyms">`,
            ...value.synonyms.map((synonym) => `        <item>${escapeXml(synonym)}</item>`),
            '    </string-array>',
        ];
    });
    return `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n${strings.join('\n')}\n</resources>\n`;
}

module.exports = function withAppActions(config) {
    // Keep the alias map next to the XML so a manifest edit updates both. The
    // live enabled catalog remains authoritative when a cold shortcut runs.
    writeBakedJs(bundledShortcuts());

    config = withDangerousMod(config, ['android', (c) => {
        const shortcuts = bundledShortcuts();
        const res = join(c.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res');
        const packageName = c.android?.package;
        mkdirSync(join(res, 'xml'), { recursive: true });
        mkdirSync(join(res, 'values'), { recursive: true });

        writeStable(join(res, 'values', 'muxr_shortcuts.xml'), shortcutResources(shortcuts));
        const locales = [...new Set(shortcuts.flatMap((shortcut) => Object.keys(shortcut.localized)))].sort();
        const activeLocaleFiles = new Set(locales.map((locale) => join(res, `values-${androidLocaleQualifier(locale)}`, 'muxr_shortcuts.xml')));
        for (const entry of readdirSync(res, { withFileTypes: true })) {
            if (!entry.isDirectory() || !entry.name.startsWith('values-')) continue;
            const stale = join(res, entry.name, 'muxr_shortcuts.xml');
            if (existsSync(stale) && !activeLocaleFiles.has(stale)) unlinkSync(stale);
        }
        for (const locale of locales) {
            const values = join(res, `values-${androidLocaleQualifier(locale)}`);
            mkdirSync(values, { recursive: true });
            writeStable(join(values, 'muxr_shortcuts.xml'), shortcutResources(shortcuts, locale));
        }

        // url-template turns the Assistant match into an ordinary deep link, so
        // no native intent bridging is needed: expo-router already handles it.
        const target = packageName === undefined ? [] : [
            `            android:targetPackage="${escapeXml(packageName)}"`,
            `            android:targetClass="${escapeXml(packageName)}.MainActivity"`,
        ];
        const entries = shortcuts.map((shortcut) => [
            `    <shortcut`,
            `        android:shortcutId="${escapeXml(shortcut.shortcutId)}"`,
            `        android:enabled="true"`,
            `        android:icon="@mipmap/ic_launcher"`,
            `        android:shortcutShortLabel="@string/muxr_shortcut_${shortcut.resourceName}_short"`,
            `        android:shortcutLongLabel="@string/muxr_shortcut_${shortcut.resourceName}_long">`,
            `        <intent`,
            `            android:action="android.intent.action.VIEW"`,
            ...target,
            `            android:data="muxr://shortcut/${escapeXml(shortcut.shortcutId)}" />`,
            `        <capability-binding android:key="actions.intent.OPEN_APP_FEATURE">`,
            `            <parameter-binding`,
            `                android:key="feature"`,
            `                android:value="@array/muxr_shortcut_${shortcut.resourceName}_synonyms" />`,
            `        </capability-binding>`,
            `    </shortcut>`,
        ].join('\n'));

        writeStable(join(res, 'xml', 'shortcuts.xml'), [
            '<?xml version="1.0" encoding="utf-8"?>',
            '<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">',
            '    <capability android:name="actions.intent.OPEN_APP_FEATURE">',
            '        <intent>',
            '            <url-template android:value="muxr://shortcut{/featureParam}" />',
            '            <parameter android:name="feature" android:key="featureParam" />',
            '        </intent>',
            '    </capability>',
            ...entries,
            '</shortcuts>',
            '',
        ].join('\n'));
        return c;
    }]);

    return withAndroidManifest(config, (c) => {
        const activity = AndroidConfig.Manifest.getMainActivityOrThrow(c.modResults);
        activity['meta-data'] = (activity['meta-data'] ?? []).filter((entry) => entry.$['android:name'] !== 'android.app.shortcuts');
        activity['meta-data'].push({ $: { 'android:name': 'android.app.shortcuts', 'android:resource': '@xml/shortcuts' } });
        return c;
    });
};

module.exports.bundledShortcutData = bundledShortcutData;
module.exports.shortcutResources = shortcutResources;
