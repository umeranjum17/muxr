/**
 * Native pairing over the byokit link (migration step 4).
 *
 * The `muxr pair` side runs in this process through the real `linkPair`:
 * a pairing host under its own key, registered at the real relay, with the
 * approval answered here the way the terminal prompt answers it. The phone
 * side runs through the real `pairOverLink` (hostedE2ee) against the same
 * relay, with its secure store mocked. The machine is the real self-host host
 * process, which enrols the phone from the device record the CLI wrote.
 *
 * Covered: a successful pairing (the same two words on both screens, the
 * device record durable, the machine link serving the new phone), a declined
 * approval, an expired pairing window, and a phone that resumes by key after
 * dying between approval and completion.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import {
    DeviceLink,
    b64url,
    hostId,
    keyPair,
    pairWithOffer,
    type DeviceGrant,
    type LinkStatus,
} from '@byokit/link';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { waitForRelay } from './waitForRelay.mjs';
import { machineIdentity } from '../../setup/index.mjs';
import type { StoredHostedGrant } from '../../../apps/mobile/sources/pairing/application/hostedE2ee.js';
import { LinkFirstClient } from '../../../apps/mobile/sources/pairing/infrastructure/linkFirstClient.js';

const home = mkdtempSync(join(tmpdir(), 'muxr-link-pairing-'));
process.env.MUXR_HOME = home;
const children = new Set<ChildProcess>();

const phone = vi.hoisted(() => ({ secure: new Map<string, string>(), local: new Map<string, string>(), platform: 'android' as 'android' | 'web' }));

vi.mock('react-native', () => ({
    Platform: { get OS() { return phone.platform; } },
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock('expo-device', () => ({ isDevice: true }));
vi.mock('expo-secure-store', () => ({
    getItemAsync: async (key: string) => phone.secure.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { phone.secure.set(key, value); },
    deleteItemAsync: async (key: string) => { phone.secure.delete(key); },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (key: string) => phone.local.get(key) ?? null,
        setItem: async (key: string, value: string) => { phone.local.set(key, value); },
        removeItem: async (key: string) => { phone.local.delete(key); },
    },
}));

const { linkPair: runComputerPairing, readSelfhostState } = await import('../../setup/index.mjs');
const { pairOverLink: runPhonePairing, resumePendingHostedPairing } = await import('../../../apps/mobile/sources/pairing/application/hostedE2ee.js');

const repoRoot = join(import.meta.dirname, '../../..');
const PENDING_LINK_KEY = 'muxr.hosted-e2ee.pending-link-pair.v1';

function launch(args: string[], extra: NodeJS.ProcessEnv = {}): ChildProcess & { output: () => string } {
    const env: NodeJS.ProcessEnv = { ...process.env, MUXR_HOME: home, MUXR_NO_SERVICE_COMMANDS: '1', ...extra };
    for (const key of ['RELAY_TOKEN', 'RELAY_URL', 'MACHINE_ID', 'RELAY_AUTH', 'DATA_DIR']) delete env[`MUXR_${key}`];
    const child = spawn(process.execPath, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout!.on('data', (chunk) => { out += chunk; });
    child.stderr!.on('data', (chunk) => { out += chunk; });
    children.add(child);
    child.once('exit', () => children.delete(child));
    return Object.assign(child, { output: () => out });
}

async function stop(child: ChildProcess | undefined): Promise<void> {
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
}

async function until<T>(produce: () => T | undefined | Promise<T | undefined>, what: string, timeoutMs = 20_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await produce();
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

let port = 0;
let relay: ChildProcess | undefined;
let host: (ChildProcess & { output: () => string }) | undefined;

async function startMachine(): Promise<void> {
    const started = launch([join(repoRoot, 'apps/relay/dist/main.js')], {
        MUXR_RELAY_PORT: String(port),
        MUXR_RELAY_HOST: '127.0.0.1',
        MUXR_RELAY_DATA_DIR: join(home, 'relay'),
        MUXR_RELAY_MDNS: '0',
    });
    relay = started;
    const first = port === 0;
    port = await waitForRelay(started);
    if (first) {
        writeFileSync(join(home, 'selfhost.json'), `${JSON.stringify({
            version: 1,
            machine: { ...machineIdentity(undefined), name: 'Desk' },
            relayPort: port,
            relayUrl: `ws://127.0.0.1:${port}`,
            relayLocation: 'local',
            relayRole: 'single-machine',
            connectionMode: 'lan',
            webEnabled: false,
            mintSecret: JSON.parse(readFileSync(join(home, 'relay', 'mint-secret'), 'utf8')),
        }, null, 2)}\n`, { mode: 0o600 });
    }
    host = launch([join(repoRoot, 'apps/host/dist/main.js'), '--fake'], { MUXR_MODE: 'selfhost' });
    const running = host;
    await until(() => (running.output().includes('host -> ') ? true : undefined), 'host start');
}

/** Options `linkPair` on the computer side accepts (untyped .mjs import). */
interface ComputerPairingOptions {
    approve?: (req: { name: string; words: string }) => boolean | Promise<boolean>;
    signal?: AbortSignal;
    /** Shortened pairing window for the expiry scenario. */
    pairMs?: number;
}

/** Starts a computer pairing and resolves once its QR is on screen. */
async function showPairingQr(options: Omit<ComputerPairingOptions, 'signal'>): Promise<{
    pairing: Promise<unknown>;
    offer: string;
    abort: () => Promise<void>;
}> {
    let out = '';
    const controller = new AbortController();
    options = { ...options, signal: controller.signal };
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true; });
    const pairing = runComputerPairing(readSelfhostState(), options).finally(() => spy.mockRestore());
    const offer = await until(() => /byokit-link:1:[A-Za-z0-9_-]+/.exec(out)?.[0], 'pairing offer on screen');
    return {
        pairing,
        offer,
        abort: async () => {
            controller.abort();
            await pairing.catch(() => undefined);
        },
    };
}

function machineGrant(stored: StoredHostedGrant): DeviceGrant {
    const machineKey = Buffer.from(stored.machineBoxPublicKey, 'base64');
    return {
        v: 1,
        secretKey: Buffer.from(stored.deviceKey.secretKey, 'base64').toString('base64url'),
        host: machineKey.toString('base64url'),
        hostName: stored.machineName ?? 'Desk',
        urls: [`ws://127.0.0.1:${port}/link/v1/${hostId(machineKey)}`],
        device: { id: 'pending', name: 'Android phone', role: 'control' },
    };
}

describe('native pairing over the byokit link', () => {
    beforeAll(async () => {
        vi.stubGlobal('WebSocket', WebSocket);
        await startMachine();
    });

    afterAll(async () => {
        vi.unstubAllGlobals();
        await Promise.all([...children].map((child) => stop(child)));
        rmSync(home, { recursive: true, force: true });
    });

    it('rejects a native offer on web before storing a pending key', async () => {
        phone.platform = 'web';
        try {
            await expect(runPhonePairing('byokit-link:1:invalid')).rejects.toThrow('Native pairing codes are for phones');
            expect(phone.secure.has(PENDING_LINK_KEY)).toBe(false);
        } finally {
            phone.platform = 'android';
        }
    });

    it('pairs with the words on both screens and serves the new phone over the machine link', async () => {
        let computerWords = '';
        let computerSawName = '';
        const { pairing, offer } = await showPairingQr({
            approve: async (req) => {
                computerWords = req.words;
                computerSawName = req.name;
                return true;
            },
        });
        expect(offer).toMatch(/^byokit-link:1:/);
        let phoneWords = '';
        const stored = await runPhonePairing(offer, { onWords: (words) => { phoneWords = words; } });
        expect(computerSawName).toBe('Android phone');
        expect(computerWords).not.toBe('');
        expect(phoneWords).toBe(computerWords);

        const state = readSelfhostState();
        const record = state.machine.crypto.devices.find((device) => device.deviceId === stored.deviceId);
        expect(record).toBeDefined();
        expect(record!.devicePublicKey).toBe(stored.devicePublicKey);
        expect(record!.name).toBe('Android phone');
        expect(stored.credential).toBe(''); // link-only: no relay credential until the cutover
        expect(stored.machineId).toBe(state.machine.id);
        expect(await pairing).toMatchObject({ deviceId: record!.deviceId, devicePublicKey: record!.devicePublicKey });

        // The machine link serves the freshly paired phone.
        const statuses: LinkStatus[] = [];
        const link = new DeviceLink(machineGrant(stored), {
            WebSocket: WebSocket as never,
            onStatus: (status) => statuses.push(status),
        });
        await until(() => (link.status === 'online' ? true : undefined), 'new phone comes online over the machine link', 30_000);
        const listed = await link.request('client.hello', { type: 'client.hello', clientId: 'link-paired-phone' }) as { type: string };
        expect(listed.type).toBe('session.list');
        link.stop();

        const client = new LinkFirstClient({
            mode: 'hosted', relayUrl: stored.relayUrl, machineId: stored.machineId,
            token: stored.credential, hostedGrant: stored, requestTimeoutMs: 5_000,
        });
        try {
            client.connect();
            await until(() => client.isLive() ? true : undefined, 'new phone session connects');
            const sessions = await client.request('session.list', {});
            expect(Array.isArray(sessions)).toBe(true);
        } finally {
            client.close();
        }
    }, 90_000);


    it('pairs nothing when the person at the computer declines', async () => {
        const { pairing, offer, abort } = await showPairingQr({ approve: async () => false });
        await expect(runPhonePairing(offer)).rejects.toThrow('Your computer said no to this device.');
        const state = readSelfhostState();
        expect(state.machine.crypto.devices).toHaveLength(1); // only the first pairing's record
        await abort();
        await expect(pairing).rejects.toThrow('cancelled');
        expect(phone.secure.has(PENDING_LINK_KEY)).toBe(false);
    }, 90_000);


    it('refuses a claim once the pairing window has passed', async () => {
        const { offer, abort } = await showPairingQr({ approve: async () => true, pairMs: 1_200 });
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await expect(runPhonePairing(offer)).rejects.toThrow('run out');
        await abort();
    }, 90_000);


    it('completes a pairing for a phone that died between approval and the machine details', async () => {
        const { pairing, offer } = await showPairingQr({ approve: async () => true });
        // The phone claims and is approved, then the app process dies before
        // `pair.complete`: exactly the pending state `pairOverLink` persists.
        const kp = keyPair();
        phone.secure.set(PENDING_LINK_KEY, JSON.stringify({
            scanned: offer,
            name: 'Android phone',
            secretKey: b64url(kp.secretKey),
            startedAt: Date.now(),
        }));
        await pairWithOffer(offer, { name: 'Android phone', key: kp, onWords: () => undefined });

        // Restart: the resume reconnects by key alone and finishes the pairing.
        const stored = await resumePendingHostedPairing(false);
        expect(stored?.machineId).toBe(readSelfhostState().machine.id);
        expect(phone.secure.has(PENDING_LINK_KEY)).toBe(false);
        expect(await pairing).toBeDefined();
    }, 90_000);


    it('lists and revokes a link-paired phone with relay fallback', async () => {
        const state = readSelfhostState();
        const paired = state.machine.crypto.devices;
        expect(paired).toHaveLength(2);
        const target = paired[0]!;
        const listing = launch([join(repoRoot, 'scripts/cli.mjs'), 'devices', 'list']);
        await until(() => (listing.exitCode === null ? undefined : listing.exitCode), 'devices list finishes');
        expect(listing.exitCode).toBe(0);
        expect(listing.output()).toContain(target.name!);

        const revoking = launch([join(repoRoot, 'scripts/cli.mjs'), 'devices', 'revoke', '1']);
        await until(() => (revoking.exitCode === null ? undefined : revoking.exitCode), 'revoke finishes', 30_000);
        expect(revoking.exitCode, revoking.output()).toBe(0);
        await until(() => (readSelfhostState().machine.crypto.devices.some((device) => device.deviceId === target.deviceId) ? undefined : true), 'record removed');
    }, 90_000);

});
