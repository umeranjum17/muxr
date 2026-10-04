import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/appVersion', () => ({ getAppVersion: () => '0.1.27' }));

import { hostId, unb64url } from '@byokit/link';
import { linkUrl } from '@byokit/relay/device';

// Retry while the computer is unreachable must not die on a version-skewed
// relay health probe. Both tests drive the real LinkFirstClient over a real
// relay and a real host endpoint; only the /health body is a fixture, since a
// dev relay reports 'unknown' where production reports its semver release.
describe('link retry across a version-skewed relay', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    async function startRelayFixture() {
        const { mkdtempSync, readFileSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { startRelay } = await import('@muxr/relay');
        const dir = mkdtempSync(join(tmpdir(), 'muxr-retry-wedge-'));
        const relay = await startRelay({ port: 0, config: { dataDir: join(dir, 'relay') } });
        const ownerToken = JSON.parse(readFileSync(join(dir, 'relay', 'mint-secret'), 'utf8'));
        return { dir, relay, ownerToken, relayWs: `ws://127.0.0.1:${relay.port}/relay` };
    }

    function stubRelayHealth(muxrVersion: string) {
        const realFetch = globalThis.fetch;
        vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return new Response(JSON.stringify({ ok: true, muxrVersion, linkProtocol: 1 }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            return realFetch(input as RequestInfo, init);
        });
    }

    function machineCrypto(machine: { publicKey: string; secretKey: string }, signing: { publicKey: string; secretKey: string }, phonePublicKey: string) {
        return {
            signingPublicKey: signing.publicKey,
            signingSecretKey: signing.secretKey,
            boxPublicKey: machine.publicKey,
            boxSecretKey: machine.secretKey,
            dataKey: Buffer.alloc(32).toString('base64'),
            keyVersion: 1,
            devices: [{
                deviceId: 'fixture-phone',
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                devicePublicKey: phonePublicKey,
                ingressKey: 'fixture',
                authority: 'control' as const,
            }],
        };
    }

    async function openEndpoint(options: {
        relayWs: string; ownerToken: string; machineKeys: { publicKey: string; secretKey: string };
        signing: { publicKey: string; secretKey: string }; phonePublicKey: string;
    }) {
        const { LinkEndpoint } = await import('../../../../host/src/machine/index');
        const { machineHello } = await import('@trymuxr/contract');
        const crypto = machineCrypto(options.machineKeys, options.signing, options.phonePublicKey);
        const endpoint = await LinkEndpoint.open({
            relayUrl: options.relayWs,
            ownerToken: options.ownerToken,
            machineId: 'machine',
            machineName: 'Umer',
            crypto,
            currentCrypto: () => crypto,
            savePushLevel: () => undefined,
            grants: { load: () => [], save: () => undefined },
            canView: () => false,
            onStatus: () => undefined,
            onDeviceConnection: () => undefined,
            answer: async (frame) => {
                if (frame.type === 'machine.hello') {
                    return { type: 'result', requestId: frame.requestId, ok: true, data: machineHello('machine', '0.2.0') };
                }
                throw new Error(`Unexpected retry-wedge request: ${frame.type}`);
            },
        });
        return endpoint;
    }

    function testGrant(options: {
        machinePublicKey: string; phone: { publicKey: string; secretKey: string };
        relayWs: string; linkUrl?: string;
    }) {
        return {
            machineId: 'machine',
            machineSigningPublicKey: 'fixture-signing',
            machineBoxPublicKey: options.machinePublicKey,
            deviceKey: options.phone,
            devicePublicKey: options.phone.publicKey,
            deviceId: 'fixture-phone',
            keyVersion: 1,
            dataKey: Buffer.alloc(32).toString('base64'),
            ingressKey: 'fixture',
            expiresAt: Date.now() + 60_000,
            credential: '',
            source: 'selfhost' as const,
            authority: 'control' as const,
            machineName: 'Umer',
            relayUrl: options.relayWs,
            ...(options.linkUrl === undefined ? {} : { linkUrl: options.linkUrl }),
        };
    }

    it('keeps retrying while offline against a version-skewed relay, then opens when the computer returns', { timeout: 90_000 }, async () => {
        const { generateKeyPair, generateSigningKeyPair } = await import('@trymuxr/crypto');
        const { LinkFirstClient } = await import('./linkFirstClient');
        const { rmSync } = await import('node:fs');
        const fixture = await startRelayFixture();
        stubRelayHealth('9.9.9');
        const machine = generateKeyPair();
        const signing = generateSigningKeyPair();
        const phone = generateKeyPair();
        const states: string[] = [];
        const errors: string[] = [];
        const client = new LinkFirstClient({
            hostedGrant: testGrant({ machinePublicKey: machine.publicKey, phone, relayWs: fixture.relayWs }),
            onPermanentError: (message) => { errors.push(message); },
        });
        client.onStateChange((state) => { states.push(state); });
        let endpoint: Awaited<ReturnType<typeof openEndpoint>> | undefined;
        try {
            // The computer is unreachable; only the relay answers, and its
            // release skews from the app's. Tapping Retry must not strand the
            // phone on a permanent Update-needed card.
            client.connect();
            await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), { timeout: 30_000 });
            expect(states).not.toContain('stale');
            expect(errors.some((message) => message.startsWith('Update needed'))).toBe(false);
            // The computer comes back: the still-live link admits the host and
            // opens without relaunching the app.
            endpoint = await openEndpoint({
                relayWs: fixture.relayWs, ownerToken: fixture.ownerToken,
                machineKeys: machine, signing, phonePublicKey: phone.publicKey,
            });
            endpoint.start();
            await vi.waitFor(() => expect(states).toContain('open'), { timeout: 60_000 });
            expect(client.isLive()).toBe(true);
            expect(errors.some((message) => message.startsWith('Update needed'))).toBe(false);
        } finally {
            client.close();
            endpoint?.close();
            await fixture.relay.close();
            rmSync(fixture.dir, { recursive: true, force: true });
        }
    });

    it('a refused pairing against a version-skewed relay still lands on the permanent Update-needed card', { timeout: 60_000 }, async () => {
        const { generateKeyPair, generateSigningKeyPair } = await import('@trymuxr/crypto');
        const { LinkFirstClient } = await import('./linkFirstClient');
        const { rmSync } = await import('node:fs');
        const fixture = await startRelayFixture();
        stubRelayHealth('9.9.9');
        const machineA = generateKeyPair();
        const machineB = generateKeyPair();
        const signingB = generateSigningKeyPair();
        const phone = generateKeyPair();
        // The stored dial address now answers with a different computer's key:
        // a genuine wrong-host refusal, not a host coming back.
        const toBase64Url = (value: string): string => value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const hostBUri = linkUrl(fixture.relayWs, hostId(unb64url(toBase64Url(machineB.publicKey))));
        const states: string[] = [];
        const errors: string[] = [];
        const client = new LinkFirstClient({
            hostedGrant: testGrant({ machinePublicKey: machineA.publicKey, phone, relayWs: fixture.relayWs, linkUrl: hostBUri }),
            onPermanentError: (message) => { errors.push(message); },
        });
        client.onStateChange((state) => { states.push(state); });
        const endpointB = await openEndpoint({
            relayWs: fixture.relayWs, ownerToken: fixture.ownerToken,
            machineKeys: machineB, signing: signingB, phonePublicKey: phone.publicKey,
        });
        try {
            endpointB.start();
            client.connect();
            await vi.waitFor(() => expect(errors.some((message) => message.startsWith('Update needed'))).toBe(true), { timeout: 30_000 });
            expect(states).toContain('stale');
            expect(states).not.toContain('open');
            // The guard holds: retrying a refused pairing does not escape stale.
            client.connect();
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            expect(client.state).toBe('stale');
        } finally {
            client.close();
            endpointB.close();
            await fixture.relay.close();
            rmSync(fixture.dir, { recursive: true, force: true });
        }
    });
});
