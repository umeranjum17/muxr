/*
 * sodium-javascript (loaded by @byokit/link) probes globalThis.crypto once at
 * module load: WebCrypto on web, require('crypto') on node. Hermes has
 * neither, so its randombytes stays a stub that throws and every Noise
 * handshake dies at its first nonce. Feed it expo-crypto's getRandomValues;
 * browsers keep their native crypto untouched.
 */
import { getRandomValues } from 'expo-crypto';

const globals = globalThis as { crypto?: { getRandomValues?: (array: Parameters<typeof getRandomValues>[0]) => ReturnType<typeof getRandomValues> } };
if (globals.crypto?.getRandomValues === undefined) {
    globals.crypto = { getRandomValues: (array) => getRandomValues(array) };
}
