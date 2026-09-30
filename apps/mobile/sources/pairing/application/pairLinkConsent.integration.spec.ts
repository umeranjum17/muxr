import { offerText } from '@byokit/link';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pairLinkOffer } from './usePairing';
import { listPairedGrants, resumePendingHostedPairing } from './linkPairing';

const harness = vi.hoisted(() => ({
    device: 'phone' as 'phone' | 'browser',
    machineName: 'Desk',
    approved: false,
    alerts: [] as string[],
    activated: false,
    loseAcknowledgement: false,
    secrets: new Map<string, string>(),
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
    pairingDeviceName: () => 'Phone',
    assertSupportedOffer: () => undefined,
}));
vi.mock('../infrastructure/linkGrant', () => ({ probeDiscoveredRelay: vi.fn() }));
vi.mock('@/connection', () => ({
    getCachedConnectionSettings: vi.fn(),
    loadConnectionSettingsAsync: vi.fn(),
    saveConnectionSettings: vi.fn(),
}));
vi.mock('../infrastructure/nativeSecretStore', () => ({
    getNativeSecret: async (key: string) => harness.secrets.get(key) ?? null,
    setNativeSecret: async (key: string, value: string) => { harness.secrets.set(key, value); },
    deleteNativeSecret: async (key: string) => { harness.secrets.delete(key); },
}));
vi.mock('../infrastructure/webSecureStore', () => ({}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('../infrastructure/linkPairClient', () => ({
    linkOfferName: () => harness.machineName,
    newPairingSecretKey: () => 'key',
    pairingFailure: (cause: Error) => ({ message: cause.message, discard: false }),
    provenLinkGrant: () => ({
        machineId: 'desk', machineName: harness.machineName,
        credential: 'credential', deviceKey: { secretKey: 'key' }, keyVersion: 1,
    }),
    claimLinkPairing: async (_pending: unknown, options: {
        mode: string;
        onWords?: (words: string) => void;
        onProven: (answer: unknown, key: unknown) => Promise<void>;
    }) => {
        if (!harness.approved) throw new Error('must not pair after the user declines');
        options.onWords?.('spark castle');
        await options.onProven({}, {});
        if (harness.loseAcknowledgement && options.mode === 'claim') throw new Error('acknowledgement lost');
    },
}));
vi.mock('./useCheckCameraPermissions', () => ({ useCheckScannerPermissions: () => async () => true }));
vi.mock('./PairMachine', () => ({ pairMachine: async () => { harness.activated = true; return { ok: true, credential: 'credential', secretKey: 'key' }; } }));
vi.mock('./deliverScannedPairing', () => ({ deliverScannedPairingLink: async () => undefined }));

function linkOffer(payload: Record<string, unknown>): string {
    return offerText({ v: 1, host: Buffer.alloc(32, 1).toString('base64url'), ticket: Buffer.alloc(16, 2).toString('base64url'),
        urls: ['wss://relay.example.test/link/v1/host'], expires: Date.now() + 120_000, name: 'Desk', ...payload });
}

beforeEach(() => {
    harness.confirms.length = 0;
    harness.alerts.length = 0;
    harness.approved = false;
    harness.activated = false;
    harness.device = 'phone';
    harness.machineName = 'Desk';
    harness.loseAcknowledgement = false;
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

// The screen's Pair press owns consent; progress must never leave an alert over Home.
it('pairs after one screen consent, shows words inline, and activates without another tap', async () => {
    harness.approved = true;
    const progress: Array<{ phase: string; title: string; words?: string }> = [];
    const login = vi.fn(async () => undefined);
    const consent = vi.fn(async () => true);
    const paired = await pairLinkOffer(linkOffer({ role: 'control', name: 'Desk' }), { login } as never, {
        confirm: consent,
        onProgress: (view) => progress.push(view),
    });
    expect(paired).toBe(true);
    expect(consent).toHaveBeenCalledTimes(1);
    expect(consent).toHaveBeenCalledWith('Pair with Desk?', expect.stringContaining('see and change things on it'));
    expect(harness.confirms).toHaveLength(0);
    expect(progress).toEqual([
        expect.objectContaining({ phase: 'compare', words: 'spark castle' }),
        expect.objectContaining({ phase: 'paired', title: 'This phone is paired with Desk.' }),
    ]);
    expect(harness.activated).toBe(true);
    expect(login).toHaveBeenCalledWith('credential', 'key');
    expect(harness.alerts).toHaveLength(0);

    harness.loseAcknowledgement = true;
    await expect(pairLinkOffer(linkOffer({ role: 'control', name: 'Desk' }), { login } as never, {
        confirm: consent,
    })).rejects.toMatchObject({ message: 'acknowledgement lost', recovery: 'saved' });
    expect(await listPairedGrants()).toEqual([expect.objectContaining({ machineName: 'Desk' })]);
    expect(await resumePendingHostedPairing()).toMatchObject({ machineName: 'Desk' });

    harness.loseAcknowledgement = false;
    login.mockRejectedValueOnce(new Error('login failed'));
    await expect(pairLinkOffer(linkOffer({ role: 'control', name: 'Desk' }), { login } as never, {
        confirm: consent,
    })).rejects.toMatchObject({ message: 'login failed', recovery: 'saved' });
    expect(await listPairedGrants()).toEqual([expect.objectContaining({ machineName: 'Desk' })]);
});
