import { offerText } from '@byokit/link';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pairLinkOffer } from './usePairing';

const harness = vi.hoisted(() => ({
    device: 'phone' as 'phone' | 'browser',
    noun: 'iPhone',
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
    pairingDeviceNoun: () => harness.noun,
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
    harness.noun = 'iPhone';
    harness.machineName = 'Desk';
});

describe('pairLinkOffer consent', () => {
    it('states control access for a control grant', async () => {
        const declined = await pairLinkOffer(linkOffer({ role: 'control', name: 'Desk' }), {} as never);
        expect(declined).toBe(false);
        expect(harness.confirms).toHaveLength(1);
        expect(harness.confirms[0]?.title).toBe('Pair with Desk?');
        expect(harness.confirms[0]?.body).toContain('This iPhone can see and change things on Desk');
    });

    it('states view-only access for a --browser-view grant', async () => {
        harness.device = 'browser';
        harness.noun = 'browser';
        const declined = await pairLinkOffer(linkOffer({ role: 'view', name: 'Desk' }), {} as never);
        expect(declined).toBe(false);
        expect(harness.confirms).toHaveLength(1);
        expect(harness.confirms[0]?.title).toBe('Pair with Desk?');
        expect(harness.confirms[0]?.body).toContain("This browser can see Desk, but can't change anything");
        expect(harness.confirms[0]?.body).not.toContain('see and change');
        expect(harness.confirms[0]?.body).toContain('muxr pair --browser-view');
    });

    it('reads the role from a wrapped app-scheme offer', async () => {
        const declined = await pairLinkOffer(`muxr://pair#${linkOffer({ role: 'view', name: 'Desk' })}`, {} as never);
        expect(declined).toBe(false);
        expect(harness.confirms).toHaveLength(1);
        expect(harness.confirms[0]?.body).toContain("This iPhone can see Desk, but can't change anything");
        expect(harness.confirms[0]?.body).not.toContain('see and change');
    });

    it('states full control when the offer carries no readable role', async () => {
        const declined = await pairLinkOffer(linkOffer({ name: 'Desk' }), {} as never);
        expect(declined).toBe(false);
        expect(harness.confirms).toHaveLength(1);
        expect(harness.confirms[0]?.body).toContain('This iPhone can see and change things on Desk');
        expect(harness.confirms[0]?.body).toContain('Only continue if you just ran muxr on that computer');
    });
});

it('pairs with one screen consent and inline progress without an alert over Home', async () => {
    harness.approved = true;
    harness.noun = 'iPad';
    const progress: Array<{ phase: string; words?: string }> = [];
    const login = vi.fn(async () => undefined);
    const consent = vi.fn(async (_title: string, _body: string) => true);
    expect(await pairLinkOffer(linkOffer({ role: 'control', name: 'Desk' }), { login } as never, {
        confirm: consent,
        onProgress: (view) => progress.push(view),
    })).toBe(true);
    expect(consent).toHaveBeenCalledTimes(1);
    expect(consent.mock.calls[0]?.[1]).toContain('This iPad can see and change things on Desk');
    expect(harness.confirms).toHaveLength(0);
    expect(progress).toEqual([
        expect.objectContaining({ phase: 'compare', words: 'spark castle' }),
        expect.objectContaining({ phase: 'paired', title: 'This iPad is paired with Desk.' }),
    ]);
    expect(login).toHaveBeenCalledWith('credential', 'key');
    expect(harness.alerts).toHaveLength(0);
});
