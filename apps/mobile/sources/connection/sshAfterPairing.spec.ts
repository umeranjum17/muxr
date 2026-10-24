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
vi.mock('@/catalog/sync', () => ({ syncReconnect: async () => undefined }));

const tunnel = vi.hoisted(() => ({
    openSshTunnel: vi.fn(),
    closeSshTunnel: vi.fn(),
    verifySshCredentials: vi.fn(),
    inspectSshHostKey: vi.fn(async () => 'SHA256:abc'),
    livePort: 0,
}));
vi.mock('../../modules/ssh-tunnel', () => ({
    isSshTunnelSupported: () => true,
    openSshTunnel: tunnel.openSshTunnel,
    closeSshTunnel: tunnel.closeSshTunnel,
    verifySshCredentials: tunnel.verifySshCredentials,
    inspectSshHostKey: tunnel.inspectSshHostKey,
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
    isSshHostKeyPinMissing,
    parseSshFields,
    saveReviewedSshSettings,
    SshConnectionError,
    sshRelayUrl,
    tunnelPairingUrl,
    verifySshCredential,
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

beforeEach(async () => {
    await saveConnectionSettings(DEFAULT_CONNECTION);
    tunnel.openSshTunnel.mockReset();
    tunnel.closeSshTunnel.mockReset();
    tunnel.livePort = 0;
    tunnel.verifySshCredentials.mockReset();
    tunnel.verifySshCredentials.mockResolvedValue({ hostKey: 'SHA256:abc' });
    tunnel.inspectSshHostKey.mockClear();
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

        const result = await applySshAfterPairing(FIELDS, { hostKey: 'SHA256:abc' });

        expect(result).toEqual({ ok: true });
        expect(secrets.setNativeSecret).toHaveBeenCalledWith('muxr.ssh.credential.v1.m1', JSON.stringify({ password: 'hunter2' }));
        expect(getCachedConnectionSettings().ssh).toEqual({ host: 'box.lan', username: 'ume', port: 22, relayPort: 8792, hostKey: 'SHA256:abc' });
    });

    it('routes a paired machine’s side channels through SSH without changing another machine’s relay', async () => {
        await pairAs(true, 'm3');
        await applySshAfterPairing(FIELDS, { hostKey: 'SHA256:abc' });
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

        expect(await applySshAfterPairing({ ...FIELDS, host: 'elsewhere.lan' })).toEqual({ ok: false, message: 'Confirm the SSH host fingerprint before signing in.' });
        expect(getCachedConnectionSettings().ssh?.host).toBe('box.lan');
    });

    it('refuses a saved SSH route with no confirmed pin before anything dials', async () => {
        await pairAs(true, 'm4');
        const pinless = { host: 'box.lan', username: 'ume', port: 22, relayPort: 8792 };
        await saveConnectionSettings({ ...getCachedConnectionSettings(), ssh: pinless });
        tunnel.openSshTunnel.mockClear();

        const refused = await sshRelayUrl('wss://public.example:8792/sync', 'm4', pinless)
            .then(() => undefined, (error: unknown) => error);

        expect(refused).toBeInstanceOf(SshConnectionError);
        expect((refused as Error).message).toBe('Confirm the SSH host fingerprint in Connection settings before reconnecting.');
        // The predicate Home routes on must recognise what this producer throws.
        expect(isSshHostKeyPinMissing((refused as Error).message)).toBe(true);
        expect(tunnel.openSshTunnel).not.toHaveBeenCalled();
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

        const parsed = parseSshFields(FIELDS);
        if ('error' in parsed) throw new Error(parsed.error);
        tunnel.verifySshCredentials.mockClear();
        await expect(verifySshCredential(parsed.target, parsed.credential)).rejects.toThrow('Confirm');
        expect(tunnel.verifySshCredentials).not.toHaveBeenCalled();

        let consent!: (accepted: boolean) => void;
        const pending = establishSshTunnel(FIELDS, async (fingerprint) => {
            expect(fingerprint).toBe('SHA256:abc');
            return new Promise<boolean>((resolve) => { consent = resolve; });
        });
        await vi.waitFor(() => expect(consent).toBeDefined());
        expect(tunnel.verifySshCredentials).not.toHaveBeenCalled();
        expect(tunnel.openSshTunnel).not.toHaveBeenCalled();
        consent(true);
        const result = await pending;

        expect(result).toEqual({ ok: true, localPort: 8792, hostKey: 'SHA256:abc' });
        expect(tunnel.verifySshCredentials).toHaveBeenCalledWith(expect.objectContaining({ host: 'box.lan', password: 'hunter2' }));
        expect(tunnel.openSshTunnel).toHaveBeenCalledWith(expect.objectContaining({
            host: 'box.lan',
            port: 22,
            username: 'ume',
            remoteHost: '127.0.0.1',
            remotePort: 8792,
            knownHostKey: 'SHA256:abc',
        }));
        tunnel.verifySshCredentials.mockClear();
        const cancelled = await establishSshTunnel(FIELDS, async () => false);
        expect(cancelled).toEqual({ ok: false, message: 'SSH cancelled. No login details were sent.' });
        expect(tunnel.verifySshCredentials).not.toHaveBeenCalled();
    });

    it('carries the actionable SSH failure copy instead of claiming', async () => {
        tunnel.openSshTunnel.mockRejectedValueOnce(Object.assign(new Error('auth failed'), { code: 'ssh-auth' }));
        const result = await establishSshTunnel(FIELDS, async () => true);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.message).toContain('refused these credentials');
    });

    it('re-pairing verifies the new key even if a tunnel opens concurrently, without disturbing a live route on failure', async () => {
        tunnel.openSshTunnel.mockResolvedValue({ localPort: 8792, hostKey: 'SHA256:abc' });
        tunnel.openSshTunnel.mockClear();
        tunnel.closeSshTunnel.mockClear();
        tunnel.verifySshCredentials.mockRejectedValueOnce(Object.assign(new Error('rejected'), { code: 'ssh-auth' }));

        const stale = await establishSshTunnel({ ...FIELDS, password: '', privateKey: 'stale-key' }, async () => true);

        expect(stale.ok).toBe(false);
        expect(stale.ok === false && stale.message).toContain('refused these credentials');
        expect(tunnel.verifySshCredentials).toHaveBeenCalledWith(expect.objectContaining({ privateKey: 'stale-key' }));
        expect(tunnel.openSshTunnel).not.toHaveBeenCalled();
        expect(tunnel.closeSshTunnel).not.toHaveBeenCalled();

        tunnel.livePort = 8792;
        tunnel.verifySshCredentials.mockResolvedValueOnce({ hostKey: 'SHA256:new' });
        const changedHost = await establishSshTunnel(FIELDS, async () => true);
        expect(changedHost.ok).toBe(false);
        expect(changedHost.ok === false && changedHost.message).toContain('SSH fingerprint');
        expect(tunnel.closeSshTunnel).not.toHaveBeenCalled();

        expect(await establishSshTunnel(FIELDS, async () => true)).toEqual({ ok: true, localPort: 8792, hostKey: 'SHA256:abc' });
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

    it('saves Direct SSH keeping a confirmed pin for an unchanged endpoint without probing', async () => {
        await pairAs(true, 'm1');
        await saveConnectionSettings({
            ...getCachedConnectionSettings(),
            ssh: { host: 'box.lan', username: 'ume', port: 22, relayPort: 8792, hostKey: 'SHA256:old' },
        });
        const confirm = vi.fn(async () => true);

        const saved = await saveReviewedSshSettings(
            { ...FIELDS, password: '', credentialPresent: true },
            { lastConnectionError: null, confirm },
        );

        expect(saved.ok).toBe(true);
        expect(tunnel.inspectSshHostKey).not.toHaveBeenCalled();
        expect(tunnel.verifySshCredentials).not.toHaveBeenCalled();
        expect(confirm).not.toHaveBeenCalled();
        expect(tunnel.closeSshTunnel).not.toHaveBeenCalled();
        expect(getCachedConnectionSettings().ssh).toEqual({ host: 'box.lan', username: 'ume', port: 22, relayPort: 8792, hostKey: 'SHA256:old' });
    });

    it('drops the pin and shows the live fingerprint after a changed-key refusal from connect or save probe', async () => {
        await pairAs(true, 'm1');
        await saveConnectionSettings({
            ...getCachedConnectionSettings(),
            ssh: { host: 'box.lan', username: 'ume', port: 22, relayPort: 8792, hostKey: 'SHA256:old' },
        });

        // Refusal copy from the real producer (describe via verify), not a hand-written literal.
        tunnel.verifySshCredentials.mockRejectedValueOnce(Object.assign(new Error('host key changed'), { code: 'ssh-host-key' }));
        const refused = await establishSshTunnel(FIELDS);
        expect(refused.ok).toBe(false);
        const lastConnectionError = refused.ok === false ? refused.message : '';
        expect(lastConnectionError).toMatch(/^The SSH fingerprint for .* changed\./);

        tunnel.inspectSshHostKey.mockResolvedValueOnce('SHA256:new');
        const seenFromSocket: string[] = [];
        const fromSocket = await saveReviewedSshSettings(
            { ...FIELDS, password: '', credentialPresent: true },
            {
                lastConnectionError,
                confirm: async (fingerprint) => { seenFromSocket.push(fingerprint); return true; },
            },
        );
        expect(fromSocket.ok).toBe(true);
        expect(seenFromSocket).toEqual(['SHA256:new']);
        expect(getCachedConnectionSettings().ssh?.hostKey).toBe('SHA256:new');
        expect(tunnel.closeSshTunnel).toHaveBeenCalledTimes(1);

        // Same recovery when the changed key is first seen on this save's credential probe
        // (socketError still null — live tunnel may still be up).
        await saveConnectionSettings({
            ...getCachedConnectionSettings(),
            ssh: { host: 'box.lan', username: 'ume', port: 22, relayPort: 8792, hostKey: 'SHA256:old' },
        });
        tunnel.closeSshTunnel.mockClear();
        tunnel.verifySshCredentials
            .mockRejectedValueOnce(Object.assign(new Error('host key changed'), { code: 'ssh-host-key' }))
            .mockResolvedValueOnce({ hostKey: 'SHA256:probed' });
        tunnel.inspectSshHostKey.mockResolvedValueOnce('SHA256:probed');
        const seenFromProbe: string[] = [];

        const fromProbe = await saveReviewedSshSettings(
            { ...FIELDS, password: 'new-secret' },
            {
                lastConnectionError: null,
                confirm: async (fingerprint) => { seenFromProbe.push(fingerprint); return true; },
            },
        );

        expect(fromProbe.ok).toBe(true);
        expect(tunnel.inspectSshHostKey).toHaveBeenCalled();
        expect(seenFromProbe).toEqual(['SHA256:probed']);
        expect(getCachedConnectionSettings().ssh).toEqual({ host: 'box.lan', username: 'ume', port: 22, relayPort: 8792, hostKey: 'SHA256:probed' });
        expect(tunnel.closeSshTunnel).toHaveBeenCalledTimes(1);
        expect(secrets.setNativeSecret).toHaveBeenCalledWith('muxr.ssh.credential.v1.m1', JSON.stringify({ password: 'new-secret' }));
    });
});
