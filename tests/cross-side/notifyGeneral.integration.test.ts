import { boxKeyPair, sealNotice } from '@byokit/seal';
import { generateKeyPair, generateSigningKeyPair } from '@trymuxr/crypto';
import { Buffer } from 'node:buffer';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openLifecycleNotice, isOpenableNotifyUrl } from '@/utils/openLifecycleNotice';
import { generalNoticeEnvelope, LinkEndpoint, parseGeneralNotice, startRelay, type MachineCryptoState } from './host.js';

/**
 * The one new agreement slice 1 adds: what the host seals for a general
 * notification is what the app opens. Real validation, real envelope, real
 * seal, real opener — only the relay wire between them is iPad-proven.
 */
describe('general notification seal agreement', () => {
    const machineId = 'lab-machine';
    const device = boxKeyPair();
    const grant = (secretKey: Uint8Array) => ({
        machineId,
        deviceKey: { secretKey: Buffer.from(secretKey).toString('base64') },
    });

    function sealedPayload(input: { title: string; body?: string; url?: string; id?: string }) {
        const parsed = parseGeneralNotice({ ...input, future: 'ignored' });
        if ('error' in parsed) throw new Error(parsed.error);
        const sealed = sealNotice(
            generalNoticeEnvelope({ ...parsed.notice, machineId }),
            device.publicKey,
        );
        return { notice: parsed.notice, sealed };
    }

    it('opens a valid sealed notice with its link', () => {
        const { notice, sealed } = sealedPayload({
            title: 'Decision needed',
            body: 'Pick a layout',
            url: 'https://example.com/a',
            id: 'k-1',
        });
        const opened = openLifecycleNotice({ data: sealed }, [grant(device.secretKey)]);
        expect(opened.title).toBe('Decision needed');
        expect(opened.body).toBe('Pick a layout');
        expect(opened.data).toMatchObject({
            eventId: 'k-1',
            kind: 'notify',
            machineId,
            presentationOwner: 'relay-push',
            url: 'https://example.com/a',
        });
        expect(notice).toEqual({ title: 'Decision needed', body: 'Pick a layout', url: 'https://example.com/a', id: 'k-1' });
        expect(isOpenableNotifyUrl(opened.data.url)).toBe(true);
    });

    it('falls back to generic text when the seal does not open', () => {
        const { sealed } = sealedPayload({ title: 'Hi' });
        const opened = openLifecycleNotice({ data: sealed }, [grant(boxKeyPair().secretKey)]);
        expect(opened).toEqual({ title: 'Agent update', body: 'An agent has an update.', data: {} });
    });

    it('fans a general notice out only to devices set to all', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-notify-general-'));
        const relay = await startRelay({ port: 0, config: { dataDir: join(dir, 'relay') } });
        let endpoint: LinkEndpoint | undefined;
        try {
            const machine = generateKeyPair();
            const signing = generateSigningKeyPair();
            const phone = (deviceId: string, pushLevel?: 'off' | 'important' | 'all') => ({
                deviceId,
                devicePublicKey: generateKeyPair().publicKey,
                ingressKey: 'unused',
                authority: 'control' as const,
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                ...(pushLevel === undefined ? {} : { pushLevel }),
            });
            const crypto: MachineCryptoState = {
                signingPublicKey: signing.publicKey, signingSecretKey: signing.secretKey,
                boxPublicKey: machine.publicKey, boxSecretKey: machine.secretKey,
                dataKey: Buffer.alloc(32).toString('base64'), keyVersion: 1,
                // Only the every-notification phone takes a general notice; Off,
                // Important only and "never subscribed" all stay silent.
                devices: [phone('every-phone', 'all'), phone('important-phone', 'important'), phone('off-phone', 'off'), phone('silent-phone')],
            };
            endpoint = await LinkEndpoint.open({
                relayUrl: `ws://127.0.0.1:${relay.port}/relay`,
                ownerToken: JSON.parse(readFileSync(join(dir, 'relay', 'mint-secret'), 'utf8')) as string,
                machineName: 'Desk',
                crypto,
                currentCrypto: () => crypto,
                savePushLevel: () => undefined,
                grants: { load: () => [], save: () => undefined },
                answer: async () => undefined,
                canView: () => true,
            });
            endpoint!.start();
            expect(endpoint!.notifyGeneral({ title: 'Hi', body: '', url: 'https://example.com/a', id: 'k-1', machineId })).toBe(1);
        } finally {
            endpoint?.close();
            relay.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);

    it('only opens loopback/tailnet http and any https link', () => {
        expect(isOpenableNotifyUrl('https://example.com/a')).toBe(true);
        expect(isOpenableNotifyUrl('http://localhost:3000/a')).toBe(true);
        expect(isOpenableNotifyUrl('http://127.0.0.1:3000/a')).toBe(true);
        expect(isOpenableNotifyUrl('http://desk.ts.net/a')).toBe(true);
        expect(isOpenableNotifyUrl('http://127.0.0.1.attacker.example/a')).toBe(false);
        expect(isOpenableNotifyUrl('http://192.168.1.2/a')).toBe(false);
        expect(isOpenableNotifyUrl('ftp://x/y')).toBe(false);
        expect(isOpenableNotifyUrl(undefined)).toBe(false);
    });
});
