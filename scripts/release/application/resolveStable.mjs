import { distribution, compareVersions } from '../domain/channel.mjs';
import { resolveSealedNpm } from './resolveSealedNpm.mjs';

/** Plan an existing stable seal without rebuilding or changing its identity. */
export async function resolveStable({ directory, version, commit, registry }) {
    distribution(version, 'stable');
    const { manifest, tarball, integrity } = await resolveSealedNpm({ directory, commit, version, channel: 'stable' });
    if (registry.integrity !== undefined && registry.integrity !== integrity) throw new Error('An existing npm version has different bytes');
    const needed = registry.integrity === undefined;
    const latest = registry.tags.latest;
    if (latest) {
        distribution(latest, 'stable');
        if (compareVersions(latest, version) > 0) throw new Error('Refusing to move the stable channel backwards');
    }
    return { needed, version, channel: 'stable', distTag: 'latest', tarball, integrity, commit: manifest.source.commit, runId: manifest.build.runId, manifest };
}
