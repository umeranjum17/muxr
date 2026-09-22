import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where an add-on plugin lives now that it left the checkout bundle.
 * Prefers `MUXR_ADDONS_ROOT/<repo>` (a checkout of the public repo), then the
 * devDependency pinned in yarn.lock (`node_modules/<repo>`), then the
 * Herdr-managed GitHub install of its plugin id.
 */
export function addonDir(repo, pluginId) {
    const root = process.env.MUXR_ADDONS_ROOT?.trim();
    if (root !== undefined && root !== '' && existsSync(join(resolve(root), repo))) return join(resolve(root), repo);
    const devDependency = fileURLToPath(new URL(`../../node_modules/${repo}`, import.meta.url));
    if (existsSync(devDependency)) return devDependency;
    const github = process.env.HERDR_PLUGINS_GITHUB?.trim() || join(process.env.HOME?.trim() || homedir(), '.config', 'herdr', 'plugins', 'github');
    try {
        const found = readdirSync(github).find((entry) => entry.startsWith(`${pluginId}-`));
        if (found !== undefined) return join(github, found);
    } catch { /* no install either */ }
    throw new Error(
        `${pluginId} is no longer bundled with muxr. Clone umeranjum17/${repo} and set MUXR_ADDONS_ROOT to its parent directory, `
        + `run yarn install to fetch the pinned devDependency, `
        + `or install it first: muxr plugin install umeranjum17/${repo}`,
    );
}

export const codeAddonDir = () => addonDir('herdr-files', 'muxr.code');
export const attachmentsAddonDir = () => addonDir('herdr-attachments', 'muxr.attachments');

/**
 * A plugins root for the fake Herdr: every bundled plugin still in the
 * checkout, plus the extracted add-ons. The add-ons win their ids — the
 * bundled copies are gone once the extraction lands.
 */
export function bundledPlusAddons(sourceRoot) {
    return ({ root }) => {
        const dir = join(root, 'fixture-plugins');
        mkdirSync(dir, { recursive: true });
        const bundled = join(sourceRoot, 'plugins');
        if (existsSync(bundled)) for (const entry of readdirSync(bundled, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            try {
                symlinkSync(join(bundled, entry.name), join(dir, entry.name));
            } catch { /* already linked from a previous round */ }
        }
        for (const [name, resolveDir] of [['code', codeAddonDir], ['attachments', attachmentsAddonDir]]) {
            try {
                symlinkSync(resolveDir(), join(dir, name));
            } catch { /* already linked */ }
        }
        return dir;
    };
}
