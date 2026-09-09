import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/** Packed CLI root (host.js + crypto.js) or the git checkout root. */
export function productRoot() {
    const packedCrypto = walkFor('crypto.js');
    if (packedCrypto !== undefined && existsSync(join(dirname(packedCrypto), 'host.js'))) {
        return dirname(packedCrypto);
    }
    const checkout = walkFor('CONTEXT.md');
    if (checkout !== undefined) return dirname(checkout);
    throw new Error('muxr product root not found');
}

export function cryptoModuleUrl() {
    const packedCrypto = walkFor('crypto.js');
    if (packedCrypto !== undefined && existsSync(join(dirname(packedCrypto), 'host.js'))) {
        return pathToFileURL(packedCrypto).href;
    }
    const checkout = walkFor('packages/crypto/dist/index.js');
    if (checkout === undefined) throw new Error('muxr crypto module not found; run yarn build');
    return pathToFileURL(checkout).href;
}

export function pluginsRoot() {
    const packed = walkFor('plugins/control/herdr-plugin.toml');
    if (packed !== undefined) return dirname(dirname(packed));
    throw new Error('muxr plugins root not found');
}

export function pluginFolder(name) {
    return join(pluginsRoot(), name);
}

export function relayEntry() {
    const packed = walkFor('relay.js');
    if (packed !== undefined) return packed;
    const checkout = walkFor('apps/relay/dist/main.js');
    if (checkout === undefined) throw new Error('muxr relay runtime not found; run yarn build');
    return checkout;
}

export function hostEntry() {
    const packed = walkFor('host.js');
    if (packed !== undefined) return packed;
    const checkout = walkFor('apps/host/dist/main.js');
    if (checkout === undefined) throw new Error('muxr host runtime not found; run yarn build');
    return checkout;
}

export function webClientRoot() {
    const packed = walkFor('web/index.html');
    if (packed !== undefined) return dirname(packed);
    return undefined;
}
