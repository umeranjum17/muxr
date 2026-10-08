import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostId, keyPairFrom, offerText, parseOffer, unb64url } from '@byokit/link';
import { PairingNeedsNewCode } from '../domain/pairingString';

/**
 * Pairing lifecycle journey: pair for real (transport faked at the claim
 * boundary, storage real in memory), then redeliver the launching intent the
 * way a density change and a relaunch do — before the offer expires — and
 * require the pairing to survive with no consent sheet and no second claim.
 */
const harness = vi.hoisted(() => {
    Object.assign(globalThis, { __DEV__: false });
    return {
        secureValues: new Map<string, string>(),
        asyncValues: new Map<string, string>(),
        claims: 0,
        declined: false,
    };
});

vi.mock('react-native', () => ({
    Platform: { get OS() { return 'android'; } },
}));
vi.mock('expo-device', () => ({ isDevice: true }));
vi.mock('expo-secure-store', () => ({
    getItemAsync: async (key: string) => harness.secureValues.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { harness.secureValues.set(key, value); },
    deleteItemAsync: async (key: string) => { harness.secureValues.delete(key); },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (key: string) => harness.asyncValues.get(key) ?? null,
        setItem: async (key: string, value: string) => { harness.asyncValues.set(key, value); },
        removeItem: async (key: string) => { harness.asyncValues.delete(key); },
    },
}));
vi.mock('@/conversation/session', () => ({
    realtimeMachineSwitchGuard: () => ({ allowed: true }),
    stopRealtimeSession: () => undefined,
}));
vi.mock('../infrastructure/linkPairClient', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../infrastructure/linkPairClient')>();
    return {
        ...actual,
        claimLinkPairing: async (
            pending: { scanned: string; secretKey: string; name: string },
            options: { mode: 'claim' | 'resume'; onClaimed?: () => Promise<void>; onProven?: (answer: never) => Promise<void> },
        ) => {
            if (harness.declined) throw new PairingNeedsNewCode('The computer declined this pairing.');
            const parsed = parseOffer(pending.scanned, 0);
            if (parsed.expires < Date.now()) throw new PairingNeedsNewCode('That pairing code has run out.');
            harness.claims += 1;
            const key = keyPairFrom(unb64url(pending.secretKey));
            const answer = {
                machineId: `machine-${parsed.ticket}`,
                machineName: parsed.name,
                machineBoxPublicKey: Buffer.from(unb64url(parsed.host)).toString('base64url'),
                relayUrl: parsed.urls[0]?.split('/link/')[0] ?? '',
                deviceId: 'device-test',
                authority: parsed.role ?? 'control',
                expiresAt: Date.now() + 3_600_000,
                linkUrl: parsed.urls[0] ?? '',
            };
            await options.onClaimed?.();
            await options.onProven?.(answer as never);
            return { ...answer, key };
        },
    };
});

const RELAY = 'ws://127.0.0.1:33863';

function machineOffer(seed: number, overrides: { expires?: number; relay?: string } = {}): { offer: string; machineId: string } {
    const hostBytes = Buffer.alloc(32, seed);
    const urls = [`${overrides.relay ?? RELAY}/link/v1/${hostId(hostBytes)}`];
    const ticket = Buffer.alloc(16, seed).toString('base64url');
    const offer = offerText({
        v: 1,
        host: hostBytes.toString('base64url'),
        name: 'Umer-test',
        urls,
        ticket,
        expires: overrides.expires ?? Date.now() + 240_000,
        role: 'control',
    });
    return { offer, machineId: `machine-${ticket}` };
}

/** Fresh module state over the same persisted secrets: a relaunch. Same state continuing: a density change. */
async function modules() {
    const linkPairing = await import('./linkPairing');
    const pairMachine = await import('./PairMachine');
    const pairArrival = await import('./pairArrival');
    const tokenStorage = await import('@/account/infrastructure/tokenStorage');
    const connection = await import('@/connection/connectionSettings');
    return { ...linkPairing, ...pairMachine, ...pairArrival, TokenStorage: tokenStorage.TokenStorage, ...connection };
}

async function pairPhone(mod: Awaited<ReturnType<typeof modules>>, offer: string): Promise<void> {
    const grant = await mod.pairOverLink(offer);
    const paired = await mod.pairMachine({ grant });
    if (!paired.ok) throw new Error('pairMachine failed in journey');
    await mod.TokenStorage.setCredentials({ token: paired.credential, secret: paired.secretKey });
}

async function isAuthenticated(mod: Awaited<ReturnType<typeof modules>>): Promise<boolean> {
    return (await mod.TokenStorage.getCredentials()) !== null;
}

beforeEach(() => {
    harness.secureValues.clear();
    harness.asyncValues.clear();
    harness.claims = 0;
    harness.declined = false;
});

describe('pairing lifecycle journey', () => {
    it('a density change and a relaunch keep the pairing with no consent and no second claim', async () => {
        const first = await modules();
        const { offer } = machineOffer(7);
        await pairPhone(first, offer);
        expect(await first.listPairedGrants()).toHaveLength(1);
        expect(await isAuthenticated(first)).toBe(true);

        // Density change: same JS state, the OS redelivers the launching intent.
        expect(await first.resolvePairArrival(offer, { authenticated: await isAuthenticated(first), source: 'intent' })).toBe('home');

        // Relaunch: fresh JS state over the same persisted secrets.
        vi.resetModules();
        const second = await modules();
        expect(await isAuthenticated(second)).toBe(true);
        expect(await second.listPairedGrants()).toHaveLength(1);
        expect(await second.resolvePairArrival(offer, { authenticated: await isAuthenticated(second), source: 'intent' })).toBe('home');

        // The consumed offer was never claimed twice, expired or not.
        const spent = machineOffer(7, { expires: Date.now() - 60_000 });
        expect(spent.offer).not.toBe(offer);
        expect(await second.resolvePairArrival(spent.offer, { authenticated: true, source: 'intent' })).toBe('home');
        expect(harness.claims).toBe(1);
    });

    it('a different machine still shows consent, and garbage keeps the form', async () => {
        const mod = await modules();
        const { offer } = machineOffer(11);
        await pairPhone(mod, offer);
        const authenticated = await isAuthenticated(mod);

        const other = machineOffer(12);
        expect(await mod.resolvePairArrival(other.offer, { authenticated, source: 'intent' })).toBe('confirm');
        expect(await mod.resolvePairArrival('byokit-link:1:not-an-offer', { authenticated, source: 'intent' })).toBe('form');
        expect(await mod.resolvePairArrival(other.offer, { authenticated: false, source: 'intent' })).toBe('confirm');
        expect(harness.claims).toBe(1);
    });

    it('a declined claim reports its failure instead of silently going home', async () => {
        const mod = await modules();
        const { offer } = machineOffer(21);
        await pairPhone(mod, offer);
        harness.declined = true;
        // The class identity splits across the relaunch's resetModules, so
        // assert the surfaced failure rather than the constructor: what
        // matters is that a declined claim reports instead of going home.
        await expect(mod.pairOverLink(machineOffer(22).offer)).rejects.toThrow(/declined/i);
        expect(harness.claims).toBe(1);
    });
});
