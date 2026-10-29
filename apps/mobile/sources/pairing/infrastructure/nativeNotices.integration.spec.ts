import { expect, it, vi } from 'vitest';
import { keyPair, b64url } from '@byokit/pair';
import type { StoredHostedGrant } from '../application/linkPairing';

const native = vi.hoisted(() => ({
    secrets: new Map<string, string>(),
    key: [] as number[],
    targets: [] as Array<{ host: string; relay: string; key: number[] }>,
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
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
        setNoticeKey: async (key) => { native.key = key; },
        clearNoticeKey: async () => { native.key = []; },
        setAnswerTargets: async (targets) => { native.targets = targets; },
    }) };
});

import { storeGrant, deleteGrant, clearGrants, loadGrants } from './grantStore';

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
    expect(installationKey).toHaveLength(32);
    expect(b64url(Uint8Array.from(installationKey))).not.toBe(first.deviceKey.secretKey);
    await storeGrant(second);
    expect(native.key).toEqual(installationKey);
    expect(native.targets.map(({ host, relay }) => ({ host, relay }))).toEqual([
        { host: 'first', relay: 'https://relay.example' }, { host: 'second', relay: 'https://relay.example' },
    ]);
    expect((await loadGrants()).first.deviceKey).toEqual(first.deviceKey);
    await deleteGrant('first');
    expect(native.targets.map(({ host }) => host)).toEqual(['second']);
    expect(native.key).toEqual(installationKey);
    await clearGrants();
    expect(native.targets).toEqual([]);
    expect(native.key).toEqual([]);
    expect(native.secrets.has('muxr.notice-key.v1')).toBe(false);
});
