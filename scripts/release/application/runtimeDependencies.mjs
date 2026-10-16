import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { desktopHostOfSource } from './requireDesktopEngine.mjs';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * The runtime dependencies the host and relay must leave external, and that the
 * packed CLI and the desktop AppImage must install rather than bundle: each
 * carries a native addon. Derived from the manifests so both distributions use
 * one list.
 */
export function runtimeDependencies(root = process.cwd()) {
    const rootPackage = read(join(root, 'package.json'));
    const hostPackage = read(join(root, 'apps', 'host', 'package.json'));
    const desklinkHost = read(join(root, 'node_modules', '@desklink', 'host', 'package.json'));
    const desklinkPin = desktopHostOfSource(root);
    if (desklinkHost.version !== desklinkPin) {
        throw new Error(`@desklink/host installed version ${desklinkHost.version} differs from apps/host/package.json pin ${desklinkPin}; reinstall dependencies before building or packing`);
    }
    return {
        ccusage: rootPackage.dependencies.ccusage,
        ws: '^8.18.0',
        '@byokit/seal': rootPackage.dependencies['@byokit/seal'],
        '@byokit/ui-core': rootPackage.dependencies['@byokit/ui-core'],
        '@desklink/host': desklinkHost.version,
        '@byokit/accounts': hostPackage.dependencies['@byokit/accounts'],
        '@byokit/realtime': hostPackage.dependencies['@byokit/realtime'],
        '@byokit/herdr': hostPackage.dependencies['@byokit/herdr'],
        '@byokit/link': hostPackage.dependencies['@byokit/link'],
        '@byokit/relay': hostPackage.dependencies['@byokit/relay'],
        '@byokit/reach': rootPackage.dependencies['@byokit/reach'],
    };
}
