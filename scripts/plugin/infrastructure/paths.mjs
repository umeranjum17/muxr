import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function walkFor(name, from = fileURLToPath(new URL('.', import.meta.url))) {
    let directory = from;
    for (let depth = 0; depth < 8; depth += 1) {
        const candidate = join(directory, name);
        if (existsSync(candidate)) return candidate;
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
    return undefined;
}

export function pluginDocsPath() {
    return walkFor('PLUGINS.md') ?? walkFor('docs/PLUGINS.md');
}

export function pluginSkillPath() {
    return walkFor('skills/muxr/SKILL.md');
}

export function pluginReferencePath() {
    return walkFor('skills/muxr/references/plugins.md');
}

export function bundledPluginsRoot() {
    const toml = walkFor('plugins/control/herdr-plugin.toml');
    if (toml === undefined) return undefined;
    return dirname(dirname(toml));
}

export function mobilePackageJson() {
    return walkFor('apps/mobile/package.json');
}

/** Packed npm artifact root: CLI + plugin guide sit together. */
export function packedCliRoot() {
    const cli = walkFor('cli.mjs');
    if (cli === undefined) return undefined;
    const root = dirname(cli);
    if (existsSync(join(root, 'PLUGINS.md')) && existsSync(join(root, 'host.js'))) return root;
    return undefined;
}
