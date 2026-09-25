import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Flow test for the SSH route's payoff: once the pairing grant lands, the
 * SSH details a user filled in before pairing persist as the connection's
 * transport — credential into the native secret store, target into the
 * connection settings. Real connectionSettings + sshTunnel modules; only the
 * platform seams (native module, secret store, storage) are doubled.
 */

const secrets = vi.hoisted(() => ({
    setNativeSecret: vi.fn(async (_key: string, _value: string) => undefined),
    getNativeSecret: vi.fn<(_key: string) => Promise<string | null>>(async () => null),
    deleteNativeSecret: vi.fn(async (_key: string) => undefined),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: async () => null, setItem: async () => undefined },
}));
vi.mock('@/pairing/secrets', () => secrets);

const tunnel = vi.hoisted(() => ({
    openSshTunnel: vi.fn(),
    closeSshTunnel: vi.fn(),
    verifySshCredentials: vi.fn(),
    livePort: 0,
}));
vi.mock('../../modules/ssh-tunnel', () => ({
    isSshTunnelSupported: () => true,
    openSshTunnel: tunnel.openSshTunnel,
    closeSshTunnel: tunnel.closeSshTunnel,
    verifySshCredentials: tunnel.verifySshCredentials,
    sshTunnelPort: () => tunnel.livePort,
    SshTunnelError: class extends Error {
        constructor(readonly code: string, message: string) { super(message); }
        static from(error: unknown) { return error as any; }
    },
}));

import {
    applySshAfterPairing,
    channelRelayUrl,
    establishSshTunnel,
    parseSshFields,
    sshRelayUrl,
    tunnelPairingUrl,
} from './sshTunnel';
import {
    DEFAULT_CONNECTION,
    getCachedConnectionSettings,
    saveConnectionSettings,
} from './connectionSettings';

function pairAs(selfhost: boolean | undefined, machineId: string) {
    return saveConnectionSettings({
        ...DEFAULT_CONNECTION,
        mode: 'hosted',
        relayUrl: 'wss://box.lan:8792',
        machineId,
        ...(selfhost === undefined ? {} : { selfhost }),
    });
}

beforeEach(() => {
    tunnel.livePort = 0;
    tunnel.verifySshCredentials.mockReset();
    tunnel.verifySshCredentials.mockResolvedValue({ hostKey: 'SHA256:abc' });
});

const FIELDS = {
    host: 'box.lan',
    username: 'ume',
    port: '22',
    relayPort: '8792',
    password: 'hunter2',
    privateKey: '',
    passphrase: '',
};

describe('SSH route applied after pairing', () => {    it('saves the credential and switches the transport to SSH once paired', async () => {
        await pairAs(true, 'm1');
        secrets.setNativeSecret.mockClear();

        const result = await applySshAfterPairing(FIELDS);

        expect(result).toEqual({ ok: true });
        expect(secrets.setNativeSecret).toHaveBeenCalledWith('muxr.ssh.credential.v1.m1', JSON.stringify({ password: 'hunter2' }));
        expect(getCachedConnectionSettings().ssh).toEqual({ host: 'box.lan', username: 'ume', port: 22, relayPort: 8792 });
    });

    it('routes a paired machine’s side channels through SSH without changing another machine’s relay', async () => {
        await pairAs(true, 'm3');
        await applySshAfterPairing(FIELDS);
        secrets.getNativeSecret.mockResolvedValue(JSON.stringify({ password: 'hunter2' }));
        let finishOpen!: (handle: { localPort: number; hostKey: string }) => void;
        tunnel.openSshTunnel.mockImplementationOnce(() => new Promise((resolve) => { finishOpen = resolve; }));
        const before = tunnel.openSshTunnel.mock.calls.length;
        const sync = sshRelayUrl('wss://public.example:8792/sync', 'm3', getCachedConnectionSettings().ssh!);
        const voice = channelRelayUrl('wss://public.example:8792/stream', 'm3');
        await vi.waitFor(() => expect(tunnel.openSshTunnel.mock.calls.length).toBeGreaterThan(before));
        expect(tunnel.openSshTunnel).toHaveBeenCalledTimes(before + 1);
        finishOpen({ localPort: 49123, hostKey: 'SHA256:abc' });
        expect(await Promise.all([sync, voice])).toEqual([
            'ws://127.0.0.1:49123/sync', 'ws://127.0.0.1:49123/stream',
        ]);
        expect(tunnel.openSshTunnel).toHaveBeenLastCalledWith(expect.objectContaining({
            host: 'box.lan', remoteHost: '127.0.0.1', remotePort: 8792,
        }));
        tunnel.openSshTunnel.mockResolvedValueOnce({ localPort: 49123, hostKey: 'SHA256:abc' });
        expect(await channelRelayUrl('wss://public.example:8792/relay', 'm3')).toBe('ws://127.0.0.1:49123/relay');
        expect(tunnel.openSshTunnel).toHaveBeenCalledTimes(before + 2);
        expect(await channelRelayUrl('wss://public.example:8792/relay', 'other')).toBe('wss://public.example:8792/relay');
    });

    it('keeps a pinned host key for the same endpoint and pairs fresh for a new one', async () => {
        await pairAs(true, 'm2');
        await saveConnectionSettings({
            ...getCachedConnectionSettings(),
            ssh: { host: 'box.lan', username: 'ume', port: 22, relayPort: 8792, hostKey: 'SHA256:pinned' },
        });

        await applySshAfterPairing(FIELDS);
        expect(getCachedConnectionSettings().ssh).toEqual({ host: 'box.lan', username: 'ume', port: 22, relayPort: 8792, hostKey: 'SHA256:pinned' });

        await applySshAfterPairing({ ...FIELDS, host: 'elsewhere.lan' });
        expect(getCachedConnectionSettings().ssh).toEqual({ host: 'elsewhere.lan', username: 'ume', port: 22, relayPort: 8792 });
    });

    it('refuses to apply SSH when the pairing is not a self-host', async () => {
        await pairAs(undefined, '');
        const result = await applySshAfterPairing(FIELDS);
        expect(result.ok).toBe(false);
        expect(getCachedConnectionSettings().ssh).toBeUndefined();
    });

    it('carries the shared validation copy before anything is saved', async () => {
        await pairAs(true, 'm1');
        secrets.setNativeSecret.mockClear();
        const missing = applySshAfterPairing({ ...FIELDS, host: ' ', password: '', privateKey: 'k', passphrase: 'p' });
        await expect(missing).resolves.toEqual({ ok: false, message: 'Enter the SSH host and username from the machine you want to reach.' });
        expect(secrets.setNativeSecret).not.toHaveBeenCalled();

        expect(parseSshFields({ ...FIELDS, port: 'nope' })).toMatchObject({ error: expect.stringContaining('1 to 65535') });
        expect(parseSshFields({ ...FIELDS, password: 'a', privateKey: 'b' })).toMatchObject({ error: expect.stringContaining('one SSH login method') });
    });
});

describe('SSH tunnel established before pairing', () => {
    it('opens the tunnel for the parsed fields and reports its loopback port and host key', async () => {
        tunnel.openSshTunnel.mockResolvedValueOnce({ localPort: 8792, hostKey: 'SHA256:abc' });

        const result = await establishSshTunnel(FIELDS);

        expect(result).toEqual({ ok: true, localPort: 8792, hostKey: 'SHA256:abc' });
        expect(tunnel.verifySshCredentials).toHaveBeenCalledWith(expect.objectContaining({ host: 'box.lan', password: 'hunter2' }));
        expect(tunnel.openSshTunnel).toHaveBeenCalledWith(expect.objectContaining({
            host: 'box.lan',
            port: 22,
            username: 'ume',
            remoteHost: '127.0.0.1',
            remotePort: 8792,
        }));
    });

    it('carries the actionable SSH failure copy instead of claiming', async () => {
        tunnel.openSshTunnel.mockRejectedValueOnce(Object.assign(new Error('auth failed'), { code: 'ssh-auth' }));
        const result = await establishSshTunnel(FIELDS);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.message).toContain('refused these credentials');
    });

    it('re-pairing verifies the new key even if a tunnel opens concurrently, without disturbing a live route on failure', async () => {
        tunnel.openSshTunnel.mockResolvedValue({ localPort: 8792, hostKey: 'SHA256:abc' });
        tunnel.openSshTunnel.mockClear();
        tunnel.closeSshTunnel.mockClear();
        tunnel.verifySshCredentials.mockRejectedValueOnce(Object.assign(new Error('rejected'), { code: 'ssh-auth' }));

        const stale = await establishSshTunnel({ ...FIELDS, password: '', privateKey: 'stale-key' });

        expect(stale.ok).toBe(false);
        expect(stale.ok === false && stale.message).toContain('refused these credentials');
        expect(tunnel.verifySshCredentials).toHaveBeenCalledWith(expect.objectContaining({ privateKey: 'stale-key' }));
        expect(tunnel.openSshTunnel).not.toHaveBeenCalled();
        expect(tunnel.closeSshTunnel).not.toHaveBeenCalled();

        tunnel.livePort = 8792;
        tunnel.verifySshCredentials.mockResolvedValueOnce({ hostKey: 'SHA256:new' });
        const changedHost = await establishSshTunnel(FIELDS);
        expect(changedHost.ok).toBe(false);
        expect(changedHost.ok === false && changedHost.message).toContain('SSH host key');
        expect(tunnel.closeSshTunnel).not.toHaveBeenCalled();

        expect(await establishSshTunnel(FIELDS)).toEqual({ ok: true, localPort: 8792, hostKey: 'SHA256:abc' });
        tunnel.openSshTunnel.mockReset();
    });

    it('rewrites the pairing URL through the tunnel and leaves other URLs untouched', () => {
        expect(tunnelPairingUrl('wss://box.lan:8792/pair?pair=AB12', 8792)).toBe('ws://127.0.0.1:8792/pair?pair=AB12');
        expect(tunnelPairingUrl('wss://box.lan:8792?pair=AB12&x=1', 9000)).toBe('ws://127.0.0.1:9000?pair=AB12&x=1');
        expect(tunnelPairingUrl('https://box.lan/pair?pair=AB12', 9000)).toBe('https://box.lan/pair?pair=AB12');
    });

    it('pins the tunnel-seen host key and restores the real relay address when applying after a tunnel claim', async () => {
        await pairAs(true, 'm1');
        secrets.setNativeSecret.mockClear();

        const result = await applySshAfterPairing(FIELDS, { hostKey: 'SHA256:tunnel', relayUrl: 'wss://box.lan:8792' });

        expect(result).toEqual({ ok: true });
        expect(getCachedConnectionSettings().ssh).toEqual({ host: 'box.lan', username: 'ume', port: 22, relayPort: 8792, hostKey: 'SHA256:tunnel' });
        expect(getCachedConnectionSettings().relayUrl).toBe('wss://box.lan:8792');
    });
});
