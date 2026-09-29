import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock('expo-device', () => ({ isDevice: false }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null } }));
import { generateKeyPair, generateSigningKeyPair } from '@trymuxr/crypto';
import { machineHello, type MachineHello } from '@trymuxr/contract';
import { LinkEndpoint, startRelay, type MachineCryptoState } from './host.js';
import { LinkFirstClient } from '../../apps/mobile/sources/pairing/infrastructure/linkFirstClient.js';
import type { StoredHostedGrant } from '../../apps/mobile/sources/pairing/application/linkPairing.js';

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
    it('shows one re-pair notice, then serves five agents, reconnects a browser and refuses a host it cannot speak to', { timeout: 40_000 }, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-browser-link-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const relay = await startRelay({ port: 0, config: { dataDir: join(dir, 'relay') } });
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
        const old = new LinkFirstClient({
            hostedGrant: { ...stored, credential: 'old-relay-ticket' }, onPermanentError: (message) => notices.push(message) });
        old.connect();
        old.connect();
        expect(old.state).toBe('stale');
        expect(notices).toEqual([expect.stringContaining('pair again')]);
        old.close();

        const client = new LinkFirstClient({ hostedGrant: stored, onPermanentError: (message) => notices.push(message) });
        cleanups.push(() => client.close());
        client.connect();
        await until(() => client.state === 'connecting', 'first dial');
        // The host registers after the first dial has already failed; a
        // disconnected-only retry would strand this browser on an online relay.
        await new Promise((resolve) => setTimeout(resolve, 800));
        // The first host predates the handshake and cannot answer machine.hello.
        const openEndpoint = (hello?: MachineHello) => LinkEndpoint.open({
            relayUrl,
            ownerToken: JSON.parse(readFileSync(join(dir, 'relay', 'mint-secret'), 'utf8')) as string,
            machineName: 'Desk', crypto, currentCrypto: () => crypto,
            savePushLevel: () => undefined,
            grants: { load: () => [], save: () => undefined },
            answer: async (frame) => {
                if (frame.type === 'machine.hello' && hello !== undefined) return { type: 'result', requestId: frame.requestId, ok: true, data: hello };
                if (frame.type === 'machines.list') return { type: 'result', requestId: frame.requestId, ok: true, data: [{ machineId: 'machine', name: 'Desk' }] };
                if (frame.type === 'session.list') {
                    await new Promise((resolve) => setTimeout(resolve, 105));
                    return { type: 'result', requestId: frame.requestId, ok: true, data: Array.from({ length: 5 }, (_, i) => ({ id: `agent-${i}` })) };
                }
                return undefined;
            },
            canView: () => true,
        });
        let endpoint = await openEndpoint();
        expect(endpoint).toBeDefined();
        endpoint!.start();
        cleanups.push(() => endpoint?.close());
        await until(() => client.state === 'open', 'browser link retry');
        expect(client.transport).toBe('link');
        expect(await client.request('machines.list', {})).toMatchObject([{ name: 'Desk' }]);
        const catalogs = await Promise.all(Array.from({ length: 5 }, () => client.request('session.list', {})));
        expect(catalogs.every((sessions) => sessions.length === 5)).toBe(true);
        endpoint!.close();
        await until(() => client.state === 'connecting', 'link offline after host stop');
        endpoint = await openEndpoint(machineHello('machine', '0.2.1'));
        endpoint!.start();
        await until(() => client.state === 'open', 'browser reconnects to a current host');
        expect((await client.request('session.list', {})).length).toBe(5);
        expect(notices.some((notice) => notice.startsWith('Update needed'))).toBe(false);
        endpoint!.close();
        await until(() => client.state === 'connecting', 'link offline before the host update');

        // A host that has moved past every protocol this app speaks.
        endpoint = await openEndpoint({ ...machineHello('machine', '9.0.0'), protocol: 9, capabilityRange: { min: 9, max: 9 } });
        endpoint!.start();
        await until(() => client.state === 'stale', 'browser refuses the incompatible host');
        expect(notices.at(-1)).toBe('Update needed: Your computer runs muxr 9.0.0, which is newer than this app supports. Update the app, then reconnect.');
        await expect(client.request('session.list', {})).rejects.toThrow();
    });
});
