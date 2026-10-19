import { boxKeyPair, sealNotice } from '@byokit/seal';
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { openLifecycleNotice, isOpenableNotifyUrl } from '@/utils/openLifecycleNotice';
import { generalNoticeEnvelope, parseGeneralNotice } from './host.js';

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
