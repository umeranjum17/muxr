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

/**
 * The realtime voice adapter runtime, found next to the packed host bundle or
 * in the checkout. muxr ships no Herdr add-ons any more.
 */
export function voiceFolder() {
    const packed = walkFor('voice/stream.mjs');
    if (packed !== undefined) return dirname(packed);
    const checkout = walkFor('apps/host/src/voice/stream.mjs');
    if (checkout === undefined) throw new Error('muxr realtime voice runtime not found; run yarn build');
    return dirname(checkout);
}

/** The product's own Herdr management pane pack; ships inside the muxr package. */
export function panePackFolder() {
    const packed = walkFor('resources/control/herdr-plugin.toml');
    if (packed !== undefined) return dirname(packed);
    throw new Error('muxr management pane pack not found');
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

export function namingEntry() {
    const packed = walkFor('naming/server.mjs');
    if (packed !== undefined) return packed;
    const checkout = walkFor('scripts/naming/server.mjs');
    if (checkout === undefined) throw new Error('muxr naming server not found');
    return checkout;
}

export function webClientRoot() {
    const packed = walkFor('web/index.html');
    if (packed !== undefined) return dirname(packed);
    return undefined;
}
