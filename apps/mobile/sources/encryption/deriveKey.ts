import { hmac_sha512 } from "./hmac_sha512";

export type KeyTreeState = {
    key: Uint8Array,
    chainCode: Uint8Array
};

export async function deriveSecretKeyTreeRoot(seed: Uint8Array, usage: string): Promise<KeyTreeState> {
    const I = await hmac_sha512(new TextEncoder().encode(usage + ' Master Seed'), seed);
    return {
        key: I.slice(0, 32),
        chainCode: I.slice(32)
    };
}

export async function deriveSecretKeyTreeChild(chainCode: Uint8Array, index: string): Promise<KeyTreeState> {

    // Prepare data
    const data = new Uint8Array([0x0, ...new TextEncoder().encode(index)]); // prepend 0x00 for separator

    // Derive key
    const I = await hmac_sha512(chainCode, data);
    // Match the root derivation: independent 32-byte key and chain code.
    return {
        key: I.slice(0, 32),
        chainCode: I.slice(32),
    };
}

export async function deriveKey(master: Uint8Array, usage: string, path: string[]): Promise<Uint8Array> {
    let state = await deriveSecretKeyTreeRoot(master, usage);
    for (const index of path) {
        state = await deriveSecretKeyTreeChild(state.chainCode, index);
    }
    return state.key;
}