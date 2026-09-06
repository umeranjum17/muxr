import { promoteReleaseVisibility } from '../application/promoteReleaseVisibility.mjs';

const option = (key) => {
    const index = process.argv.indexOf(`--${key}`);
    if (index < 0) return undefined;
    return process.argv[index + 1];
};
const version = option('version') ?? process.env.RELEASE_VERSION;
const result = await promoteReleaseVisibility({ tag: option('tag') ?? `v${version}` });
const state = result.changed ? 'is now' : 'already was';
process.stdout.write(`${result.tag} ${state} the Latest release, titled ${result.name}\n`);
