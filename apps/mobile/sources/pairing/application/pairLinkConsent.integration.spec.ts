import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pairLinkOffer } from './usePairing';

const harness = vi.hoisted(() => ({
    device: 'phone' as 'phone' | 'browser',
    machineName: 'Desk',
    confirms: [] as Array<{ title: string; body: string }>,
}));

vi.mock('expo-camera', () => ({ CameraView: {} }));
vi.mock('@/account/ui', () => ({ useAuth: () => ({}) }));
vi.mock('@/modal', () => ({
    Modal: {
        confirm: async (title: string, body: string) => {
            harness.confirms.push({ title, body });
            return false;
        },
        alert: async () => undefined,
    },
}));
vi.mock('../infrastructure/pairingPlatform', () => ({
    pairingDeviceKind: () => harness.device,
}));
vi.mock('./linkPairing', () => ({
    linkPairMachineName: async () => harness.machineName,
    pairOverLink: async () => {
        throw new Error('must not pair after the user declines');
    },
}));
vi.mock('./useCheckCameraPermissions', () => ({ useCheckScannerPermissions: () => async () => true }));
vi.mock('./PairMachine', () => ({ pairMachine: async () => ({ ok: false }) }));
vi.mock('./deliverScannedPairing', () => ({ deliverScannedPairingLink: async () => undefined }));

function linkOffer(payload: Record<string, unknown>): string {
    return `byokit-link:1:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

beforeEach(() => {
    harness.confirms.length = 0;
    harness.device = 'phone';
    harness.machineName = 'Desk';
});

describe('pairLinkOffer consent', () => {
    it('states control access for a control grant', async () => {
        const declined = await pairLinkOffer(linkOffer({ role: 'control', name: 'Desk' }), {} as never);
        expect(declined).toBe(false);
        expect(harness.confirms).toHaveLength(1);
        expect(harness.confirms[0]?.title).toBe('Pair with Desk?');
        expect(harness.confirms[0]?.body).toContain('see and change things on it');
    });

    it('states view-only access for a --browser-view grant', async () => {
        harness.device = 'browser';
        const declined = await pairLinkOffer(linkOffer({ role: 'view', name: 'Desk' }), {} as never);
        expect(declined).toBe(false);
        expect(harness.confirms).toHaveLength(1);
        expect(harness.confirms[0]?.title).toBe('Pair with Desk?');
        expect(harness.confirms[0]?.body).toContain('see it, but not change anything');
        expect(harness.confirms[0]?.body).not.toContain('see and change');
        expect(harness.confirms[0]?.body).toContain('muxr pair --browser-view');
    });

    it('reads the role from a wrapped app-scheme offer', async () => {
        const declined = await pairLinkOffer(`muxr://pair#${linkOffer({ role: 'view', name: 'Desk' })}`, {} as never);
        expect(declined).toBe(false);
        expect(harness.confirms).toHaveLength(1);
        expect(harness.confirms[0]?.body).toContain('see it, but not change anything');
        expect(harness.confirms[0]?.body).not.toContain('see and change');
    });

    it('falls back to the neutral access copy when the offer carries no role', async () => {
        const declined = await pairLinkOffer(linkOffer({ name: 'Desk' }), {} as never);
        expect(declined).toBe(false);
        expect(harness.confirms).toHaveLength(1);
        expect(harness.confirms[0]?.body).toContain('will receive the access shown on the pairing screen');
        expect(harness.confirms[0]?.body).not.toContain('see and change');
    });
});
