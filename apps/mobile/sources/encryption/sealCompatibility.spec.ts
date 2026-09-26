import { randomBytes } from 'node:crypto';
import { expect, it, vi } from 'vitest';

vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(randomBytes(length)) }));
import { decryptBlob, encryptBlob } from './blob';
import { decryptBox, decryptSecretBox, encryptBox, encryptSecretBox, getPublicKeyForBox } from './libsodium';

// Fixed bytes sealed by libsodium-wrappers 0.8.2 before the byokit cutover.
// Reopen the existing catalog, data-key wrap and blob, then seal new bytes.
it('keeps existing NaCl catalog and blob bytes readable across the seal cutover', () => {
    const hex = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'));
    const seed = hex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    const oldBox = hex('5730800ab340fcb18ce5111eda9d705f91388b41e4544cbd103ba5942db2233e404142434445464748494a4b4c4d4e4f5051525354555657dd32010f7aff073f81d7ea44c305d60b0ca942f7d1b6cb96b6e9e15f1c1efa1375c0ab');
    const oldBlob = hex('404142434445464748494a4b4c4d4e4f5051525354555657bf53ece53b99a7b1419c62c865c2c3b7257b31595930cf4baa36164118e8239da15622');
    const oldJson = hex('404142434445464748494a4b4c4d4e4f505152535455565719cd69f7571fb256c8a5d09bf331fb233135261c4922d245a82a535b33ab2a90a052640910');
    const plain = new TextEncoder().encode('old catalog payload');
    expect(decryptBox(oldBox, seed)).toEqual(plain);
    expect(decryptBlob(oldBlob, seed)).toEqual(plain);
    expect(decryptSecretBox(oldJson, seed)).toEqual({ sessions: ['pane'] });
    expect(decryptBox(encryptBox(plain, getPublicKeyForBox(seed)), seed)).toEqual(plain);
    expect(decryptBlob(encryptBlob(plain, seed), seed)).toEqual(plain);
    expect(decryptSecretBox(encryptSecretBox({ sessions: ['pane'] }, seed), seed)).toEqual({ sessions: ['pane'] });
    expect(decryptBox(oldBox, new Uint8Array(32))).toBeNull();
});
