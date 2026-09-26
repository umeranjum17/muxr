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
 * approval, and a phone that resumes by key after dying between approval and
 * completion.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
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
import { claimLinkPairing } from '../../../apps/mobile/sources/pairing/infrastructure/linkPairClient.js';
import { SESSION_EVENT_TYPES, type SessionEvent } from '@muxr/contract';
import { parsePairingString } from '../../../apps/mobile/sources/pairing/domain/pairingString.js';

const home = mkdtempSync(join(tmpdir(), 'muxr-link-pairing-'));
process.env.MUXR_HOME = home;
const children = new Set<ChildProcess>();

const phone = vi.hoisted(() => ({ secure: new Map<string, string>(), web: new Map<string, string>(), local: new Map<string, string>(), platform: 'android' as 'android' | 'web' }));

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
vi.mock('../../../apps/mobile/sources/pairing/infrastructure/webSecureStore.js', () => ({
    getWebSecret: async (key: string) => phone.web.get(key) ?? null,
    setWebSecret: async (key: string, value: string) => { phone.web.set(key, value); },
    deleteWebSecret: async (key: string) => { phone.web.delete(key); },
    listWebSecretNames: async () => [...phone.web.keys()],
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (key: string) => phone.local.get(key) ?? null,
        setItem: async (key: string, value: string) => { phone.local.set(key, value); },
        removeItem: async (key: string) => { phone.local.delete(key); },
    },
}));

const { linkPair: runComputerPairing, pairingIntent, readSelfhostState } = await import('../../setup/index.mjs');
const { pairOverLink: runPhonePairing, resumePendingHostedPairing, loadHostedGrant, reconnectViaDiscoveredRelay } = await import('../../../apps/mobile/sources/pairing/application/hostedE2ee.js');
const { getCachedConnectionSettings, saveConnectionSettings } = await import('../../../apps/mobile/sources/connection/connectionSettings.js');

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

const advertisedAddress = Object.values(networkInterfaces()).flat().find((address) => address?.family === 'IPv4' && !address.internal)?.address;
if (advertisedAddress === undefined) throw new Error('link pairing flow needs a non-loopback IPv4 interface');
let port = 0;
let relay: ChildProcess | undefined;
let host: (ChildProcess & { output: () => string }) | undefined;

async function startMachine(): Promise<void> {
    const started = launch([join(repoRoot, 'apps/relay/dist/main.js')], {
        MUXR_RELAY_PORT: String(port),
        MUXR_RELAY_HOST: '0.0.0.0',
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
            relayUrl: `ws://${advertisedAddress}:${port}`,
            webOrigin: `https://${advertisedAddress}:${port}`,
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
    intent?: ReturnType<typeof pairingIntent>;
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
    const offer = await until(() => /(?:https?:\/\/[^\s]+\/pair#)?byokit-link:1:[A-Za-z0-9_-]+/.exec(out)?.[0], 'pairing offer on screen');
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

    it('re-pairs an older phone with matching words and carries all events and RPC over the link', async () => {
        const machineId = readSelfhostState().machine.id;
        phone.secure.set('muxr.grants.index', JSON.stringify([machineId]));
        phone.secure.set(`muxr.grant.${machineId}`, JSON.stringify({ machineId, keyVersion: 5,
            credential: 'old-relay-credential', deviceId: 'old-device' }));
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

        // A discovered locator is accepted only after the pinned host key connects there.
        const settings = getCachedConnectionSettings();
        await saveConnectionSettings({ ...settings, mode: 'hosted', machineId: stored.machineId, relayUrl: 'ws://127.0.0.1:1' });
        try {
            expect(await reconnectViaDiscoveredRelay(stored.machineId, 'ws://127.0.0.1:2')).toBe(false);
            expect(await reconnectViaDiscoveredRelay(stored.machineId, `ws://127.0.0.1:${port}`)).toBe(true);
            expect(getCachedConnectionSettings().relayUrl).toBe(`ws://127.0.0.1:${port}`);
        } finally {
            await saveConnectionSettings(settings);
        }

        const client = new LinkFirstClient({
            hostedGrant: stored, requestTimeoutMs: 5_000,
        });
        try {
            client.connect();
            await until(() => client.isLive() ? true : undefined, 'new phone session connects');
            const sessions = await client.request('session.list', {});
            expect(Array.isArray(sessions)).toBe(true);
            const cwd = join(home, 'probe-cwd');
            mkdirSync(cwd, { recursive: true });
            const events: SessionEvent[] = [];
            const unsubscribe = client.onEvent((_id, event) => events.push(event));
            const started = await client.request('session.start', { cwd }) as { info: { id: string } };
            await client.request('session.prompt', { sessionId: started.info.id, text: 'widen the event projection' });
            await until(() => SESSION_EVENT_TYPES.every((type) => events.some((event) => event.type === type)) ? true : undefined,
                'all event types over the link');
            const ordered = events.filter((event) => event.sessionId === started.info.id);
            expect(ordered.every((event, index) => index === 0 || event.seq > ordered[index - 1]!.seq)).toBe(true);
            const listed = await client.request('session.list', {}) as Array<{ id: string }>;
            expect(listed.some((session) => session.id === started.info.id)).toBe(true);
            unsubscribe();
        } finally {
            client.close();
        }
    }, 90_000);


    it('pairs a view-only browser over the link and limits its lifetime', async () => {
        phone.platform = 'web';
        try {
            let computerWords = '';
            let browserWords = '';
            const { pairing, offer } = await showPairingQr({
                intent: pairingIntent({ kind: 'browser', authority: 'observe' }),
                approve: (request) => { computerWords = request.words; return true; },
            });
            expect(offer).toMatch(/^https:\/\/[^#]+\/pair#byokit-link:1:/);
            expect(parsePairingString(offer)).toMatchObject({ ok: true, pairing: { authority: 'observe', displayName: 'Desk' } });
            const stored = await runPhonePairing(offer, { onWords: (words) => { browserWords = words; } });
            await pairing;
            expect(browserWords).toBe(computerWords);
            expect(stored.authority).toBe('observe');
            expect(stored.expiresAt).toBeGreaterThan(Date.now() + 7 * 60 * 60_000);
            expect(stored.expiresAt).toBeLessThan(Date.now() + 9 * 60 * 60_000);
            const record = readSelfhostState().machine.crypto.devices.find((entry) => entry.deviceId === stored.deviceId);
            expect(record).toMatchObject({ kind: 'browser', authority: 'observe' });
            expect(phone.web.has(`muxr.grant.${stored.machineId}`)).toBe(true);
            const client = new LinkFirstClient({ hostedGrant: stored });
            client.connect();
            await until(() => client.isLive() ? true : undefined, 'browser machine link');
            await expect(client.request('machines.list', {})).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Desk' })]));
            client.close();
        } finally { phone.platform = 'android'; }
    });

    it('pairs over a forwarded link when the advertised relay is unreachable', async () => {
        const { pairing, offer } = await showPairingQr({ approve: () => true });
        const payload = JSON.parse(Buffer.from(offer.slice('byokit-link:1:'.length), 'base64url').toString('utf8')) as { urls: string[] };
        payload.urls = payload.urls.map((url) => url.replace(`${advertisedAddress}:${port}`, '127.0.0.1:1'));
        const forwarded = `byokit-link:1:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
        const stored = await runPhonePairing(forwarded, { tunnelPort: port });
        await pairing;
        expect(stored.credential).toBe('');
        expect(readSelfhostState().machine.crypto.devices.some((device) => device.deviceId === stored.deviceId)).toBe(true);
    });

    it('keeps the phone grant if the verified reply is lost after the computer commits', async () => {
        const machineId = readSelfhostState().machine.id;
        const previous = await loadHostedGrant(machineId);
        const { pairing, offer } = await showPairingQr({ approve: () => true });
        const original = DeviceLink.prototype.request;
        const lost = vi.spyOn(DeviceLink.prototype, 'request').mockImplementation(async function (...args) {
            const answer = await original.apply(this, args);
            if (args[0] === 'pair.verified') throw new Error('lost verification reply');
            return answer;
        });
        try { await expect(runPhonePairing(offer)).rejects.toThrow('lost verification reply'); }
        finally { lost.mockRestore(); }
        await pairing;
        const persisted = await loadHostedGrant(machineId);
        expect(persisted?.deviceId).not.toBe(previous?.deviceId);
        expect(readSelfhostState().machine.crypto.devices.some((device) => device.deviceId === persisted?.deviceId)).toBe(true);
    }, 90_000);

    it('pairs nothing when the person at the computer declines', async () => {
        const { pairing, offer, abort } = await showPairingQr({ approve: async () => false });
        await expect(runPhonePairing(offer)).rejects.toThrow('Your computer said no to this device.');
        const state = readSelfhostState();
        expect(state.machine.crypto.devices).toHaveLength(4); // phone, browser, forwarded, and lost-reply pairings
        await abort();
        await expect(pairing).rejects.toThrow('cancelled');
        expect(phone.secure.has(PENDING_LINK_KEY)).toBe(false);
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


    it('lists and revokes a link-paired phone from the host record', async () => {
        const state = readSelfhostState();
        const paired = state.machine.crypto.devices;
        expect(paired).toHaveLength(5);
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

    it('keeps an approved non-loopback claim alive while the phone reconnects to finish pairing', async () => {
        const { pairing, offer, abort } = await showPairingQr({ approve: () => true });
        try {
            const key = keyPair();
            await pairWithOffer(offer, { name: 'Android phone', key, onWords: () => undefined, WebSocket: WebSocket as never });
            // A remote phone can take longer than the host's two-second device-record
            // reconciliation to reconnect after approval. Its grant is provisional
            // until pair.complete writes the durable record.
            await new Promise((resolve) => setTimeout(resolve, 3_000));
            const answer = await claimLinkPairing({ scanned: offer, name: 'Android phone', secretKey: b64url(key.secretKey) }, { mode: 'resume' });
            expect(answer.relayUrl).toBe(`ws://${advertisedAddress}:${port}`);
            expect(await pairing).toMatchObject({ deviceId: answer.deviceId });
        } finally {
            await abort();
        }
    }, 90_000);

    it('names a pairing-link drop after the confirmation words', async () => {
        const { pairing, offer, abort } = await showPairingQr({ approve: async () => {
            await stop(relay);
            return true;
        } });
        try {
            await expect(runPhonePairing(offer, { onWords: () => undefined }))
                .rejects.toThrow('The pairing link closed after the two words');
        } finally {
            await abort();
            await pairing.catch(() => undefined);
        }
    }, 90_000);
});
