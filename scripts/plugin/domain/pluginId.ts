import { accepted, rejected, type Result } from './result.js';

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const OPTIONAL_VOICE_ADAPTERS: Record<string, true> = {
    'muxr.voice-openai': true,
    'muxr.voice-gemini': true,
    'muxr.voice-codex': true,
};

export function parsePluginId(value: unknown): Result<string> {
    if (typeof value === 'string' && ID_RE.test(value)) return accepted(value);
    return rejected('plugin id must match [a-z0-9][a-z0-9._-]{0,63}');
}

export function isPluginId(value: unknown): value is string {
    return parsePluginId(value).ok;
}

/**
 * A bundled plugin. The stable Plugin Id authorizes link/enable/unlink.
 * Folder names are filesystem paths only.
 */
export type BundledPlugin = {
    id: string;
    folderName: string;
    enabledByDefault: boolean;
};

export function parseBundledPlugin(id: unknown, folderName: string): Result<BundledPlugin> {
    const parsed = parsePluginId(id);
    if (!parsed.ok) return parsed;
    return accepted({
        id: parsed.value,
        folderName,
        enabledByDefault: OPTIONAL_VOICE_ADAPTERS[parsed.value] !== true,
    });
}

export type RetiredBundled = { successor: string; directory: string };

export function retiredSuccessor(pluginId: string): RetiredBundled | undefined {
    return RETIRED.get(pluginId);
}

const RETIRED = new Map<string, RetiredBundled>([
    ['muxr.file-viewer', { successor: 'muxr.code', directory: 'file-viewer' }],
    ['muxr.changes', { successor: 'muxr.code', directory: 'changes' }],
    ['muxr.git-history', { successor: 'muxr.code', directory: 'git-history' }],
    ['muxr.runbook', { successor: 'muxr.code', directory: 'runbook' }],
    ['muxr.usage-status', { successor: 'muxr.status', directory: 'usage-status' }],
    ['muxr.vitals', { successor: 'muxr.status', directory: 'vitals' }],
    ['muxr.ports', { successor: 'muxr.servers', directory: 'ports' }],
    ['muxr.run-server', { successor: 'muxr.servers', directory: 'run-server' }],
]);
