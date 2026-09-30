import { offerText } from '@byokit/link';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pairLinkOffer } from './usePairing';

const harness = vi.hoisted(() => ({
    device: 'phone' as 'phone' | 'browser',
    machineName: 'Desk',
    approved: false,
    alerts: [] as string[],
    confirms: [] as Array<{ title: string; body: string }>,
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('expo-camera', () => ({ CameraView: {} }));
vi.mock('@/account/ui', () => ({ useAuth: () => ({}) }));
vi.mock('@/modal', () => ({
    Modal: {
        confirm: async (title: string, body: string) => {
            harness.confirms.push({ title, body });
            return harness.approved;
        },
        alert: async (title: string) => { harness.alerts.push(title); },
    },
}));
vi.mock('../infrastructure/pairingPlatform', () => ({
    pairingDeviceKind: () => harness.device,
}));
vi.mock('./linkPairing', () => ({
    linkPairMachineName: async () => harness.machineName,
    pairOverLink: async (_scanned: string, options: { onWords: (words: string) => void }) => {
        if (!harness.approved) throw new Error('must not pair after the user declines');
        options.onWords('spark castle');
        return { machineName: harness.machineName };
    },
}));
vi.mock('./useCheckCameraPermissions', () => ({ useCheckScannerPermissions: () => async () => true }));
vi.mock('./PairMachine', () => ({ pairMachine: async () => ({ ok: true, credential: 'credential', secretKey: 'key' }) }));
vi.mock('./deliverScannedPairing', () => ({ deliverScannedPairingLink: async () => undefined }));

function linkOffer(payload: Record<string, unknown>): string {
    return offerText({ v: 1, host: Buffer.alloc(32, 1).toString('base64url'), ticket: Buffer.alloc(16, 2).toString('base64url'),
        urls: ['wss://relay.example.test/link/v1/host'], expires: Date.now() + 120_000, name: 'Desk', ...payload });
}

beforeEach(() => {
    harness.confirms.length = 0;
    harness.approved = false;
    harness.alerts.length = 0;
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

it('pairs with one screen consent and inline progress without an alert over Home', async () => {
    harness.approved = true;
    const progress: Array<{ phase: string; words?: string }> = [];
    const login = vi.fn(async () => undefined);
    const consent = vi.fn(async () => true);
    expect(await pairLinkOffer(linkOffer({ role: 'control', name: 'Desk' }), { login } as never, {
        confirm: consent,
        onProgress: (view) => progress.push(view),
    })).toBe(true);
    expect(consent).toHaveBeenCalledTimes(1);
    expect(harness.confirms).toHaveLength(0);
    expect(progress).toEqual([
        expect.objectContaining({ phase: 'compare', words: 'spark castle' }),
        expect.objectContaining({ phase: 'paired' }),
    ]);
    expect(login).toHaveBeenCalledWith('credential', 'key');
    expect(harness.alerts).toHaveLength(0);
});
