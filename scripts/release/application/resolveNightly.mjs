import { distribution, compareVersions } from '../domain/channel.mjs';
import { resolveSealedNpm } from './resolveSealedNpm.mjs';

export function nightlyVersion(tag, requestedVersion = '') {
    const version = typeof tag === 'string' && tag.startsWith('v') ? tag.slice(1) : '';
    distribution(version, 'nightly');
    if (requestedVersion && requestedVersion !== version) throw new Error('Requested version does not match the nightly tag');
    return version;
}

/** Read only: bind both seals and the npm bytes to the tag, then plan publication. */
export async function resolveNightly({ directory, tag, requestedVersion, commit, registry }) {
    const version = nightlyVersion(tag, requestedVersion);
    const { manifest, tarball, integrity } = await resolveSealedNpm({ directory, commit, version, channel: 'nightly' });
    if (registry.integrity !== undefined && registry.integrity !== integrity) throw new Error('An existing npm version has different bytes');
    const needed = registry.integrity === undefined;
    if (needed) {
        const stable = registry.tags.latest;
        distribution(stable, 'stable');
        if (compareVersions(version, stable) <= 0) throw new Error(`${version} does not sort above the published stable ${stable}`);
        const current = registry.tags.nightly;
        if (current && (compareVersions(current, version) === undefined || compareVersions(current, version) > 0)) throw new Error('Refusing to move the nightly channel backwards');
    }
    return { needed, version, channel: 'nightly', distTag: 'nightly', tarball, integrity, commit, runId: manifest.build.runId, manifest };
}
