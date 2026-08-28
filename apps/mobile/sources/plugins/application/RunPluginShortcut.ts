import { PLUGIN_CALL_CLIENT_TIMEOUT_MS, type PluginShortcut } from '@muxr/contract';
import { sync } from '@/sync/sync';
import { capabilityFor } from './capabilityRegistry';
import { pluginSnapshot, refreshPlugins } from './pluginStore';
import baked from '../bundledShortcuts.json';

type BakedShortcut = { id: string; aliases?: string[] };

function key(value: string): string {
    try {
        return decodeURIComponent(value).trim().toLowerCase();
    } catch {
        return value.trim().toLowerCase();
    }
}

function canonicalShortcutId(shortcutId: string): string {
    const needle = key(shortcutId);
    return (baked as BakedShortcut[]).find((entry) =>
        key(entry.id) === needle || (entry.aliases ?? []).some((alias) => key(alias) === needle),
    )?.id ?? shortcutId;
}

export type RunPluginShortcutCommand = { shortcutId: string };

export type RunPluginShortcutResult = { ok: true } | { ok: false };

/**
 * Run a plugin shortcut by its canonical id (`<pluginId>.<contributionId>`)
 * or a legacy alias from an older deep link.
 *
 * The baked Android mapping is identity/alias data only. The enabled catalog is
 * authoritative even on cold start, so a disabled plugin can never open the mic.
 */
export async function runPluginShortcut(command: RunPluginShortcutCommand): Promise<RunPluginShortcutResult> {
    try {
        await refreshPlugins();
    } catch {
        return { ok: false };
    }
    const found = find(canonicalShortcutId(command.shortcutId));
    if (found === undefined) return { ok: false };
    const { shortcut, pluginId, manifestHash, manifest } = found;
    if (shortcut.action.type === 'capability') {
        await capabilityFor(shortcut.action.name, manifest)?.({ sessionId: '', status: 'shortcut', from: 'shortcut' });
        return { ok: true };
    }
    await sync.request('plugin.call', { pluginId, manifestHash, contributionId: shortcut.action.contributionId, input: { shortcutId: command.shortcutId } }, PLUGIN_CALL_CLIENT_TIMEOUT_MS);
    return { ok: true };
}

export async function runShortcut(shortcutId: string): Promise<void> {
    await runPluginShortcut({ shortcutId });
}

function find(shortcutId: string): { shortcut: PluginShortcut; pluginId: string; manifestHash: string; manifest: import('@muxr/contract').PluginManifestV1 } | undefined {
    for (const { summary, manifest } of pluginSnapshot()) {
        for (const contribution of manifest.contributions) {
            if (contribution.slot !== 'shortcuts') continue;
            if (`${summary.pluginId}.${contribution.id}` !== shortcutId) continue;
            return { shortcut: contribution as PluginShortcut, pluginId: summary.pluginId, manifestHash: summary.manifestHash, manifest };
        }
    }
    return undefined;
}
