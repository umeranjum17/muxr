import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock('expo-device', () => ({ isDevice: false }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null } }));
import { generateKeyPair, generateSigningKeyPair } from '@muxr/crypto';
import { startRelay } from '@muxr/relay';
import { LinkEndpoint } from '../../../apps/host/src/machine/infrastructure/linkEndpoint.js';
import { LinkFirstClient } from '../../../apps/mobile/sources/pairing/infrastructure/linkFirstClient.js';
import type { StoredHostedGrant } from '../../../apps/mobile/sources/pairing/application/hostedE2ee.js';
import type { MachineCryptoState } from '../../../apps/host/src/machine/domain/crypto.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function until(check: () => boolean, reason: string, ms = 12_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
        if (Date.now() >= deadline) throw new Error(`timed out: ${reason}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

describe('browser session over byokit', () => {
    it('shows one re-pair notice for an old grant, then reconnects a browser over the live link', { timeout: 25_000 }, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-browser-link-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const relay = await startRelay({ port: 0, config: { dataDir: join(dir, 'relay'), developmentApi: true } });
        cleanups.push(() => relay.close());
        const relayUrl = `ws://127.0.0.1:${relay.port}/relay`;
        const machine = generateKeyPair();
        const signing = generateSigningKeyPair();
        const browser = generateKeyPair();
        const crypto: MachineCryptoState = {
            signingPublicKey: signing.publicKey, signingSecretKey: signing.secretKey,
            boxPublicKey: machine.publicKey, boxSecretKey: machine.secretKey,
            dataKey: Buffer.alloc(32).toString('base64'), keyVersion: 1,
            devices: [{ deviceId: 'browser', kind: 'browser', devicePublicKey: browser.publicKey,
                ingressKey: 'unused', authority: 'observe', expiresAt: new Date(Date.now() + 60_000).toISOString() }],
        };
        const stored = {
            source: 'selfhost', machineId: 'machine', deviceId: 'browser',
            machineBoxPublicKey: machine.publicKey, deviceKey: browser,
            relayUrl, credential: '', authority: 'observe', expiresAt: Date.now() + 60_000,
        } as StoredHostedGrant;
        const notices: string[] = [];
        const old = new LinkFirstClient({ mode: 'hosted', machineId: 'machine', relayUrl,
            hostedGrant: { ...stored, credential: 'old-relay-ticket' }, onPermanentError: (message) => notices.push(message) });
        old.connect();
        old.connect();
        expect(old.state).toBe('stale');
        expect(notices).toEqual([expect.stringContaining('pair again')]);
        old.close();

        const client = new LinkFirstClient({ mode: 'hosted', machineId: 'machine', relayUrl, hostedGrant: stored });
        cleanups.push(() => client.close());
        client.connect();
        await until(() => client.state === 'connecting', 'first dial');
        // The host registers after the first dial has already failed; a
        // disconnected-only retry would strand this browser on an online relay.
        await new Promise((resolve) => setTimeout(resolve, 800));
        const endpoint = await LinkEndpoint.open({
            relayUrl,
            ownerToken: JSON.parse(readFileSync(join(dir, 'relay', 'mint-secret'), 'utf8')) as string,
            machineName: 'Desk', crypto, currentCrypto: () => crypto,
            savePushLevel: () => undefined,
            grants: { load: () => [], save: () => undefined },
            answer: async (frame) => frame.type === 'machines.list'
                ? { type: 'result', requestId: frame.requestId, ok: true, data: [{ machineId: 'machine', name: 'Desk' }] }
                : undefined,
            canView: () => true,
        });
        expect(endpoint).toBeDefined();
        endpoint!.start();
        cleanups.push(() => endpoint!.close());
        await until(() => client.state === 'open', 'browser link retry');
        expect(client.transport).toBe('link');
        expect(await client.request('machines.list', {})).toMatchObject([{ name: 'Desk' }]);
    });
});
