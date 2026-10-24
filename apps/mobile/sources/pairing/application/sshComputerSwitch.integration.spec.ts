import { expect, it, vi } from 'vitest';
import type { StoredHostedGrant } from './linkPairing';

const device = vi.hoisted(() => ({ secrets: new Map<string, string>(), storage: new Map<string, string>(), open: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-device', () => ({ isDevice: true }));
vi.mock('expo-secure-store', () => ({
    getItemAsync: async (key: string) => device.secrets.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { device.secrets.set(key, value); },
    deleteItemAsync: async (key: string) => { device.secrets.delete(key); },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
    getItem: async (key: string) => device.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => { device.storage.set(key, value); },
} }));
vi.mock('../../../modules/ssh-tunnel', () => ({
    isSshTunnelSupported: () => true,
    openSshTunnel: device.open,
}));
vi.mock('@/conversation/session', () => ({ realtimeMachineSwitchGuard: () => ({ allowed: true }), stopRealtimeSession: () => undefined }));
vi.mock('@/catalog/sync', () => ({ syncReconnect: async () => undefined }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'lab-request' }));
vi.mock('@/pairing', () => ({ MuxrRequestError: class extends Error {} }));
vi.mock('@/pairing/client', () => ({ LinkFirstClient: class {
    constructor() { throw new Error('An SSH-only background probe must never dial the phone’s loopback'); }
} }));

function grant(machineId: string, relayUrl: string): StoredHostedGrant {
    return { machineId, relayUrl, source: 'selfhost', credential: 'lab-grant', deviceKey: { secretKey: 'lab-secret', publicKey: 'lab-public' } } as StoredHostedGrant;
}

it('keeps a cloud computer’s pinned SSH route and key when switching away and back, including after relaunch', async () => {
    const desk = grant('desk', 'ws://desk.lan:38792');
    const cloud = grant('cloud', 'ws://127.0.0.1:8792');
    let { pairMachine } = await import('./PairMachine');
    let connection = await import('@/connection');
    expect(await pairMachine({ grant: desk })).toMatchObject({ ok: true });
    expect(await pairMachine({ grant: cloud })).toMatchObject({ ok: true });
    expect(await connection.applySshAfterPairing({
        host: 'cloud.example', port: '22', username: 'umer', relayPort: '8792',
        password: '', privateKey: 'lab-private-key', passphrase: '',
    }, { hostKey: 'SHA256:abc' })).toEqual({ ok: true });
    const pinned = connection.getCachedConnectionSettings().ssh;
    expect(pinned?.hostKey).toBe('SHA256:abc');
    expect(await pairMachine({ grant: desk })).toMatchObject({ ok: true });
    expect(connection.getCachedConnectionSettings().ssh).toBeUndefined();
    expect(await connection.hasSshCredential(cloud.machineId)).toBe(true);
    const { openPairedMachine, SshComputerNeedsActivation } = await import('@/collaboration/scopedMachineClient');
    await expect(openPairedMachine(cloud)).rejects.toBeInstanceOf(SshComputerNeedsActivation);
    await expect(openPairedMachine({ ...cloud, relayUrl: 'ws://cloud.example:8792' })).rejects.toBeInstanceOf(SshComputerNeedsActivation);

    vi.resetModules();
    ({ pairMachine } = await import('./PairMachine'));
    connection = await import('@/connection');
    await connection.loadConnectionSettingsAsync();
    expect(await pairMachine({ grant: cloud })).toMatchObject({ ok: true });
    expect(connection.getCachedConnectionSettings().ssh).toEqual(pinned);
    device.open.mockResolvedValue({ localPort: 49123, hostKey: 'SHA256:abc' });
    expect(await connection.channelRelayUrl(cloud.relayUrl, cloud.machineId)).toBe('ws://127.0.0.1:49123');
    expect(device.open).toHaveBeenCalledWith(expect.objectContaining({ host: 'cloud.example', privateKey: 'lab-private-key', knownHostKey: 'SHA256:abc', remotePort: 8792 }));

    // Upgrade from the old active-only settings: migrate before leaving that computer.
    device.secrets.delete('muxr.ssh.target.v1.cloud');
    expect(await pairMachine({ grant: desk })).toMatchObject({ ok: true });
    expect(await pairMachine({ grant: cloud })).toMatchObject({ ok: true });
    expect(connection.getCachedConnectionSettings().ssh).toEqual(pinned);
});
