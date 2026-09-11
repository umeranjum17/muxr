import { accepted, rejected, type Result } from './result.js';

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

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
};

export function parseBundledPlugin(id: unknown, folderName: string): Result<BundledPlugin> {
    const parsed = parsePluginId(id);
    if (!parsed.ok) return parsed;
    return accepted({ id: parsed.value, folderName });
}
