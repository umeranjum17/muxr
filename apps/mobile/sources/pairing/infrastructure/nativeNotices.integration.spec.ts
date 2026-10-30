import { expect, it, vi } from 'vitest';
import { keyPair, b64url } from '@byokit/pair';
import type { StoredHostedGrant } from '../application/linkPairing';

const native = vi.hoisted(() => ({
    secrets: new Map<string, string>(),
    key: [] as number[],
    targets: [] as Array<{ host: string; relay: string; key: number[] }>,
    refused: true,
    failClear: false,
    flags: new Map<string, string>(),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
    getItem: async (key: string) => native.flags.get(key) ?? null,
    setItem: async (key: string, value: string) => { native.flags.set(key, value); },
    removeItem: async (key: string) => { native.flags.delete(key); },
} }));
vi.mock('./nativeSecretStore', () => ({
    getNativeSecret: async (name: string) => native.secrets.get(name) ?? null,
    setNativeSecret: async (name: string, value: string) => { native.secrets.set(name, value); },
    deleteNativeSecret: async (name: string) => { native.secrets.delete(name); },
}));
vi.mock('./hostedSecretStore', () => ({
    secretGet: async (name: string) => native.secrets.get(name) ?? null,
    secretSet: async (name: string, value: string) => { native.secrets.set(name, value); },
    secretDelete: async (name: string) => { native.secrets.delete(name); },
    grantSecretNames: async () => [],
}));
// Only the platform bridge is replaced; kit validation and provisioning are real.
vi.mock('@byokit/push', async (original) => {
    const kit = await original<typeof import('@byokit/push')>();
    return { ...kit, ...kit.createNotices({
        setNoticeKey: async (key) => { native.key = key; native.refused = false; },
        declareSignedOut: async () => {
            native.refused = true;
            if (native.failClear) throw new Error('fixture cleanup unavailable');
            native.key = []; native.targets = [];
        },
        clearNoticeKey: async () => { native.key = []; },
        setAnswerTargets: async (targets) => { native.targets = targets; },
    }) };
});

import { storeGrant, deleteGrant, clearGrants, loadGrants } from './grantStore';
import { syncNativeNotices, nativeNoticeSecret, retryNativeNoticeCleanup, nativeNoticeCleanupPending } from './nativeNotices';

it('keeps one notice identity across distinct host pairings and removes revoked targets and keys', async () => {
    const grant = (machineId: string): StoredHostedGrant => {
        const pairing = keyPair();
        return { machineId, machineBoxPublicKey: b64url(keyPair().publicKey),
            deviceKey: { publicKey: b64url(pairing.publicKey), secretKey: b64url(pairing.secretKey) },
            relayUrl: 'wss://relay.example/relay', expiresAt: Date.now() + 60_000, authority: 'control',
        } as StoredHostedGrant;
    };
    const first = grant('first');
    const second = grant('second');
    await storeGrant(first);
    const installationKey = [...native.key];
    expect(installationKey.length).toBe(32);
    expect(b64url(Uint8Array.from(installationKey)) === first.deviceKey.secretKey).toBe(false);
    await storeGrant(second);
    expect(b64url(Uint8Array.from(native.key)) === b64url(Uint8Array.from(installationKey))).toBe(true);
    expect(native.targets.map(({ host, relay }) => ({ host, relay }))).toEqual([
        { host: 'first', relay: 'https://relay.example' }, { host: 'second', relay: 'https://relay.example' },
    ]);
    expect(JSON.stringify((await loadGrants()).first.deviceKey) === JSON.stringify(first.deviceKey)).toBe(true);
    await deleteGrant('first');
    expect(native.targets.map(({ host }) => host)).toEqual(['second']);
    expect(b64url(Uint8Array.from(native.key)) === b64url(Uint8Array.from(installationKey))).toBe(true);
    native.failClear = true;
    await syncNativeNotices([]);
    expect(native.refused).toBe(true);
    expect(await nativeNoticeCleanupPending()).toBe(true);
    expect(await nativeNoticeSecret()).toBeUndefined();
    // A retained trusted host and a stale registration cannot resume a signed-out installation.
    await syncNativeNotices([second]);
    expect(native.refused).toBe(true);
    native.failClear = false;
    await retryNativeNoticeCleanup();
    expect(await nativeNoticeCleanupPending()).toBe(false);
    await syncNativeNotices([second]);
    expect(native.refused).toBe(true);
    await storeGrant(second);
    expect(native.refused).toBe(false);
    expect(native.targets.map(({ host }) => host)).toEqual(['second']);
    await clearGrants();
    expect(native.targets).toEqual([]);
    expect(native.key.length).toBe(0);
    expect(native.secrets.has('muxr.notice-key.v1')).toBe(false);
});
