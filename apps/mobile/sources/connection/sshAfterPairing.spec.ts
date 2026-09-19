import { describe, expect, it, vi } from 'vitest';

/*
 * Flow test for the SSH route's payoff: once the pairing grant lands, the
 * SSH details a user filled in before pairing persist as the connection's
 * transport — credential into the native secret store, target into the
 * connection settings. Real connectionSettings + sshTunnel modules; only the
 * platform seams (native module, secret store, storage) are doubled.
 */

const secrets = vi.hoisted(() => ({
    setNativeSecret: vi.fn(async (_key: string, _value: string) => undefined),
    getNativeSecret: vi.fn(async (_key: string) => null),
    deleteNativeSecret: vi.fn(async (_key: string) => undefined),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: async () => null, setItem: async () => undefined },
}));
vi.mock('../../modules/ssh-tunnel', () => ({
    isSshTunnelSupported: () => true,
    openSshTunnel: vi.fn(),
    closeSshTunnel: vi.fn(),
    SshTunnelError: class extends Error {
        constructor(readonly code: string, message: string) { super(message); }
        static from(error: unknown) { return error as any; }
    },
}));
vi.mock('@/pairing/secrets', () => secrets);

import {
    applySshAfterPairing,
    parseSshFields,
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

const FIELDS = {
    host: 'box.lan',
    username: 'ume',
    port: '22',
    relayPort: '8792',
    password: 'hunter2',
    privateKey: '',
    passphrase: '',
};

describe('SSH route applied after pairing', () => {
    it('saves the credential and switches the transport to SSH once paired', async () => {
        await pairAs(true, 'm1');
        secrets.setNativeSecret.mockClear();

        const result = await applySshAfterPairing(FIELDS);

        expect(result).toEqual({ ok: true });
        expect(secrets.setNativeSecret).toHaveBeenCalledWith('muxr.ssh.credential.v1.m1', JSON.stringify({ password: 'hunter2' }));
        expect(getCachedConnectionSettings().ssh).toEqual({ host: 'box.lan', username: 'ume', port: 22, relayPort: 8792 });
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
