/**
 * Native pairing over the byokit link (migration step 4).
 *
 * The `muxr pair` side runs in this process through the real `linkPair`:
 * the running machine's owner-only pairing socket, with approval answered
 * here the way the terminal prompt answers it. The phone
 * side runs through the real `pairOverLink` (linkPairing) against the same
 * relay, with its secure store mocked. The machine is the real self-host host
 * process, which enrols the phone from the device record the CLI wrote.
 *
 * Covered: a successful pairing (the same two words on both screens, the
 * device record durable, the machine link serving the new phone), a declined
 * approval, a phone that resumes by key after dying between approval and
 * completion, and each lost acknowledgement settled by retrying the same code.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import {
    DeviceLink,
    LinkError,
    b64url,
    COMPACT_TAG,
    hostId,
    keyPair,
    pairWithOffer,
    type DeviceGrant,
    type LinkStatus,
} from '@byokit/link';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cliMain, hostMain, hostRoot, pairingIntent, relayMain, waitForRelay } from './host.js';
import { machineIdentity } from './hostSetup.js';
import type { StoredHostedGrant } from '../../apps/mobile/sources/pairing/application/linkPairing.js';
import { LinkFirstClient } from '../../apps/mobile/sources/pairing/infrastructure/linkFirstClient.js';
import { claimLinkPairing } from '../../apps/mobile/sources/pairing/infrastructure/linkPairClient.js';
import { SESSION_EVENT_TYPES, type SessionEvent } from '@trymuxr/contract';
import { parsePairingString } from '../../apps/mobile/sources/pairing/domain/pairingString.js';

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
vi.mock('../../apps/mobile/sources/pairing/infrastructure/webSecureStore.js', () => ({
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

const { linkPair: runComputerPairing, readSelfhostState } = await import('./hostSetup.js');
const { pairOverLink: runPhonePairing, resumePendingHostedPairing, loadHostedGrant, reconnectViaDiscoveredRelay, PairingNeedsNewCode } = await import('../../apps/mobile/sources/pairing/application/linkPairing.js');
const { getCachedConnectionSettings, saveConnectionSettings } = await import('../../apps/mobile/sources/connection/connectionSettings.js');

const PENDING_LINK_KEY = 'muxr.hosted-e2ee.pending-link-pair.v1';

function launch(args: string[], extra: NodeJS.ProcessEnv = {}): ChildProcess & { output: () => string } {
    const env: NodeJS.ProcessEnv = { ...process.env, MUXR_HOME: home, MUXR_NO_SERVICE_COMMANDS: '1', ...extra };
    for (const key of ['RELAY_TOKEN', 'RELAY_URL', 'MACHINE_ID', 'RELAY_AUTH', 'DATA_DIR']) delete env[`MUXR_${key}`];
    const child = spawn(process.execPath, args, { cwd: hostRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const started = launch([relayMain], {
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
    host = launch([hostMain, '--fake'], { MUXR_MODE: 'selfhost' });
    const running = host;
    await until(() => (existsSync(join(home, 'host', 'pair.sock')) ? true : undefined), `host pairing socket (${running.output()})`);
}

/** Options `linkPair` on the computer side accepts (untyped .mjs import). */
interface ComputerPairingOptions {
    approve?: (req: { name: string; words: string }) => boolean | Promise<boolean>;
    signal?: AbortSignal;
    intent?: ReturnType<typeof pairingIntent>;
}

/** Starts a computer pairing and resolves once its QR is on screen. */
async function showPairingQr(options: Omit<ComputerPairingOptions, 'signal'>, ttySize?: { columns: number; rows: number }): Promise<{
    pairing: Promise<unknown>;
    offer: string;
    abort: () => Promise<void>;
}> {
    let out = '';
    const controller = new AbortController();
    options = { ...options, signal: controller.signal };
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true; });
    const overridden: { key: 'isTTY' | 'columns' | 'rows'; descriptor: PropertyDescriptor | undefined }[] = [];
    if (ttySize !== undefined) {
        const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
        overridden.push({ key: 'isTTY', descriptor: tty });
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
        for (const key of ['columns', 'rows'] as const) {
            overridden.push({ key, descriptor: Object.getOwnPropertyDescriptor(process.stdout, key) });
            Object.defineProperty(process.stdout, key, { configurable: true, value: ttySize[key] });
        }
    }
    const pairing = runComputerPairing(readSelfhostState(), options).finally(() => {
        spy.mockRestore();
        for (const { key, descriptor } of overridden.reverse()) {
            if (descriptor === undefined) Reflect.deleteProperty(process.stdout, key);
            else Object.defineProperty(process.stdout, key, descriptor);
        }
    });
    // The machine runs one pairing at a time and frees its slot only when the
    // pairing's socket closes. A test whose offer never appears must cancel
    // its pairing, or it wedges that slot against every later pairing in the
    // file (CI once turned one slow offer into eight failures and zero
    // enrolled devices).
    const stop = async (): Promise<void> => {
        controller.abort();
        await pairing.catch(() => undefined);
    };
    const offerPattern = new RegExp(`(?:https?:\\/\\/[^\\s]+\\/pair#)?(?:byokit-link:1:[A-Za-z0-9_-]+|${COMPACT_TAG}[A-Za-z0-9_-]+)`);
    const offer = await until(() => offerPattern.exec(out)?.[0], 'pairing offer on screen', 30_000)
        .catch(async (error: unknown) => { await stop(); throw error; });
    return { pairing, offer, abort: stop };
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

    it('refuses owned and shared pairing without a running machine before showing a code', async () => {
        const state = readSelfhostState();
        const originalHome = process.env.MUXR_HOME;
        const originalWait = process.env.MUXR_PAIR_SOCKET_WAIT_MS;
        const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        process.env.MUXR_HOME = join(home, 'offline-pairing');
        // No host will ever open this socket; assert the same error at once.
        process.env.MUXR_PAIR_SOCKET_WAIT_MS = '0';
        try {
            for (const relayLocation of ['local', 'remote'] as const) {
                const connection = relayLocation === 'local' ? state : {
                    ...state, relayLocation, relayRole: 'shared', mintSecret: undefined, machineCredential: state.mintSecret,
                };
                await expect(runComputerPairing(connection, { approve: () => { throw new Error('no code should be offered'); } }))
                    .rejects.toThrow('Start muxr on this computer with `muxr daemon start`, then run `muxr pair` again.');
            }
            expect(output).not.toHaveBeenCalled();
        } finally {
            output.mockRestore();
            process.env.MUXR_HOME = originalHome;
            if (originalWait === undefined) delete process.env.MUXR_PAIR_SOCKET_WAIT_MS;
            else process.env.MUXR_PAIR_SOCKET_WAIT_MS = originalWait;
        }
    });

    it('rejects a native offer on web before storing a pending key', async () => {
        phone.platform = 'web';
        try {
            await expect(runPhonePairing('byokit-link:1:invalid')).rejects.toThrow('Native pairing codes are for phones');
            expect(phone.secure.has(PENDING_LINK_KEY)).toBe(false);
        } finally {
            phone.platform = 'android';
        }
        // A code from an older muxr names the update instead of dead-ending.
        const stale = runPhonePairing('wss://relay.example.test?pair=ABCDE-FGHIJ');
        await expect(stale).rejects.toBeInstanceOf(PairingNeedsNewCode);
        await expect(stale).rejects.toThrow('muxr 0.2.0 or older');
        expect(phone.secure.has(PENDING_LINK_KEY)).toBe(false);
    });

    it('re-pairs an older phone with matching words and carries all events and RPC over the link', async () => {
        const machineId = readSelfhostState().machine.id;
        phone.secure.set('muxr.grants.index', JSON.stringify([machineId]));
        phone.secure.set(`muxr.grant.${machineId}`, JSON.stringify({ machineId, keyVersion: 5,
            credential: 'old-relay-credential', deviceId: 'old-device' }));
        let computerWords = '';
        let computerSawName = '';
        const { pairing, offer, abort } = await showPairingQr({
            approve: async (req) => {
                computerWords = req.words;
                computerSawName = req.name;
                return true;
            },
        });
        expect(offer).toMatch(/^byokit-link:1:/);
        let phoneWords = '';
        let stored: StoredHostedGrant;
        try {
            // The phone claims exactly what the terminal shows.
            stored = await runPhonePairing(offer, { onWords: (words) => { phoneWords = words; } });
        } catch (error) { await abort(); throw error; }
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
    }, 90_000);

    it('pairs over a forwarded link when the advertised relay is unreachable', async () => {
        const { pairing, offer } = await showPairingQr({ approve: () => true });
        const payload = JSON.parse(Buffer.from(offer.slice('byokit-link:1:'.length), 'base64url').toString('utf8')) as { urls: string[] };
        payload.urls = payload.urls.map((url) => url.replace(`${advertisedAddress}:${port}`, '127.0.0.1:1'));
        const forwarded = `byokit-link:1:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
        const stored = await runPhonePairing(forwarded, { tunnelPort: port });
        await pairing;
        expect(stored.credential).toBe('');
        expect(readSelfhostState().machine.crypto.devices.some((device) => device.deviceId === stored.deviceId)).toBe(true);
    }, 90_000);

    it('settles every lost pairing acknowledgement by retrying the same code, never by claiming it again', async () => {
        const machineId = readSelfhostState().machine.id;
        const hostHas = (deviceId: string | undefined) => readSelfhostState().machine.crypto.devices.some((device) => device.deviceId === deviceId);
        const pendingAnswer = () => (JSON.parse(phone.secure.get(PENDING_LINK_KEY) ?? '{}') as { answer?: { deviceId: string } }).answer;
        /** `pair.verified` times out on the phone; `delivered` says whether the computer heard it first. */
        const loseAcknowledgement = async (offer: string, delivered: boolean) => {
            const original = DeviceLink.prototype.request;
            const lost = vi.spyOn(DeviceLink.prototype, 'request').mockImplementation(async function (this: DeviceLink, ...args) {
                if (args[0] !== 'pair.verified') return original.apply(this, args);
                if (delivered) await original.apply(this, args);
                throw new LinkError('timeout');
            });
            const previous = await loadHostedGrant(machineId);
            try {
                const attempt = runPhonePairing(offer);
                await expect(attempt).rejects.toThrow('Your computer may not have saved this pairing. Try again');
                await expect(attempt).rejects.not.toBeInstanceOf(PairingNeedsNewCode);
            } finally { lost.mockRestore(); }
            // Unconfirmed, so nothing shows as paired or replaces the working grant.
            expect((await loadHostedGrant(machineId))?.deviceId).toBe(previous?.deviceId);
            return pendingAnswer()!.deviceId;
        };

        // Acknowledged: the computer saved the device, only the reply was lost.
        let qr = await showPairingQr({ approve: () => true });
        try {
            let deviceId = await loseAcknowledgement(qr.offer, true);
            expect(await qr.pairing).toMatchObject({ deviceId });
            expect((await runPhonePairing(qr.offer)).deviceId).toBe(deviceId);
            expect((await loadHostedGrant(machineId))?.deviceId).toBe(deviceId);
            expect(phone.secure.has(PENDING_LINK_KEY)).toBe(false);

            // Timed out: the acknowledgement never arrived; Try again finishes it.
            qr = await showPairingQr({ approve: () => true });
            deviceId = await loseAcknowledgement(qr.offer, false);
            expect((await runPhonePairing(qr.offer)).deviceId).toBe(deviceId);
            expect(await qr.pairing).toMatchObject({ deviceId });
            expect(phone.secure.has(PENDING_LINK_KEY)).toBe(false);

            // Rolled back: the computer gave up first, so the phone asks for a new code.
            qr = await showPairingQr({ approve: () => true });
            const kept = await loadHostedGrant(machineId);
            deviceId = await loseAcknowledgement(qr.offer, false);
            await qr.abort();
            expect(hostHas(deviceId)).toBe(false);
            const retry = runPhonePairing(qr.offer);
            await expect(retry).rejects.toBeInstanceOf(PairingNeedsNewCode);
            await expect(retry).rejects.toThrow("This pairing didn't finish on your computer. Run `muxr pair` there and scan the new code.");
            expect((await loadHostedGrant(machineId))?.deviceId).toBe(kept?.deviceId);
            expect(phone.secure.has(PENDING_LINK_KEY)).toBe(false);
        } finally {
            // A failed step must not wedge the computer's one pairing slot.
            await qr.abort();
        }
    }, 120_000);

    it('pairs nothing when the person at the computer declines', async () => {
        const { pairing, offer, abort } = await showPairingQr({ approve: async () => false });
        await expect(runPhonePairing(offer)).rejects.toThrow('Your computer said no to this device.');
        // The computer has replaced the spent code; the old one says to use the new one.
        const superseded = runPhonePairing(offer);
        await expect(superseded).rejects.toBeInstanceOf(PairingNeedsNewCode);
        await expect(superseded).rejects.toThrow('That pairing code has run out. Show a new one on your computer.');
        const state = readSelfhostState();
        expect(state.machine.crypto.devices).toHaveLength(5); // phone, browser, forwarded, and two lost-acknowledgement pairings
        await abort();
        await expect(pairing).rejects.toThrow('cancelled');
        expect(phone.secure.has(PENDING_LINK_KEY)).toBe(false);
    }, 90_000);

    it('exits 2 asking for the person when a non-TTY caller runs muxr pair', async () => {
        // launch() gives the child no TTY, the way an AI agent or script does.
        const startedAt = Date.now();
        const child = launch([cliMain, 'pair']);
        const code = await new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)));
        const elapsedMs = Date.now() - startedAt;
        expect(elapsedMs).toBeLessThan(1_000);
        expect(code).toBe(2);
        expect(child.output().trim()).toBe('Pairing needs you at this computer\'s terminal: run `muxr pair` yourself');
    });

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
        expect(paired).toHaveLength(6);
        const target = paired[0]!;
        const listing = launch([cliMain, 'devices', 'list']);
        await until(() => (listing.exitCode === null ? undefined : listing.exitCode), 'devices list finishes');
        expect(listing.exitCode).toBe(0);
        expect(listing.output()).toContain(target.name!);

        const revoking = launch([cliMain, 'devices', 'revoke', '1']);
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

    it('keeps pairing open after Enter at the real terminal prompt, then pairs on y', async () => {
        const driver = join(home, 'terminal-pair.mjs');
        const pairModule = pathToFileURL(join(hostRoot, 'scripts/setup/application/linkPair.mjs')).href;
        writeFileSync(driver, `import { pairOnRunningHost } from ${JSON.stringify(pairModule)};\nawait pairOnRunningHost(${JSON.stringify(join(home, 'host', 'pair.sock'))});\nconsole.log('Pairing complete');\n`);
        // A real PTY exercises the default producer prompt, not an injected
        // approve callback. BSD script takes command argv; Linux takes -c.
        const args = process.platform === 'darwin'
            ? ['-q', '/dev/null', process.execPath, driver]
            : ['-qec', `${process.execPath} ${driver}`, '/dev/null'];
        const child = spawn('script', args, { cwd: hostRoot, env: { ...process.env, MUXR_HOME: home, HERDR_SESSION: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
        children.add(child);
        child.once('exit', () => children.delete(child));
        let terminal = '';
        child.stdout.on('data', (chunk) => { terminal += String(chunk); });
        child.stderr.on('data', (chunk) => { terminal += String(chunk); });
        const promptCount = () => (terminal.match(/Approve this device\?/g) ?? []).length;
        let phonePairing: Promise<StoredHostedGrant> | undefined;
        try {
            const offer = await until(() => /byokit-link:1:[A-Za-z0-9_-]+/.exec(terminal)?.[0], 'terminal offer');
            phonePairing = runPhonePairing(offer);
            // Observe rejection immediately even if prompt admission fails.
            void phonePairing.catch(() => undefined);
            await until(() => promptCount() === 1 ? true : undefined, 'approval prompt');
            child.stdin.write('\n');
            await until(() => promptCount() === 2 ? true : undefined, 'Enter re-asks');
            expect(terminal).not.toContain('Pairing complete');
            child.stdin.write('y\n');
            const stored = await phonePairing;
            expect(readSelfhostState().machine.crypto.devices.some((device) => device.deviceId === stored.deviceId)).toBe(true);
            await until(() => terminal.includes('Pairing complete') ? true : undefined, 'computer completes pairing');
        } finally {
            await stop(child);
            await phonePairing?.catch(() => undefined);
        }
    }, 60_000);

    it('pairs a phone from the compact offer the terminal shows when the full QR cannot fit', async () => {
        let computerWords = '';
        let phoneWords = '';
        // A 120x30 terminal fits the compact QR and its one-line token but not
        // the full v1 QR (39 rows), so the pairing string on screen is the
        // compact offer. Placed after every test that counts the enrolled-device
        // record, but before the link-drop test below: that one stops the relay
        // this phone must dial.
        const { pairing, offer, abort } = await showPairingQr({
            approve: async (req) => { computerWords = req.words; return true; },
        }, { columns: 120, rows: 30 });
        expect(offer.startsWith(COMPACT_TAG)).toBe(true);
        let stored: StoredHostedGrant;
        try {
            stored = await runPhonePairing(offer, { onWords: (words) => { phoneWords = words; } });
        } catch (error) { await abort(); throw error; }
        expect(phoneWords).toBe(computerWords);
        expect(phoneWords).not.toBe('');
        await pairing;
        expect(readSelfhostState().machine.crypto.devices.some((device) => device.deviceId === stored.deviceId)).toBe(true);
    }, 90_000);

    it('prints the full pairing string in plain output on an 80-column terminal', async () => {
        const previous = process.env.MUXR_NO_TUI;
        process.env.MUXR_NO_TUI = '1';
        try {
            const { pairing, offer, abort } = await showPairingQr({ approve: async () => true }, { columns: 80, rows: 24 });
            try {
                expect(offer.startsWith('byokit-link:1:')).toBe(true);
                expect(offer.length).toBeGreaterThan(200);
            } finally {
                await abort();
                await pairing.catch(() => undefined);
            }
        } finally {
            if (previous === undefined) delete process.env.MUXR_NO_TUI;
            else process.env.MUXR_NO_TUI = previous;
        }
    }, 60_000);

    it('names a pairing-link drop after the confirmation words', async () => {
        const { pairing, offer, abort } = await showPairingQr({ approve: async () => {
            await stop(relay);
            return true;
        } });
        try {
            const dropped = runPhonePairing(offer, { onWords: () => undefined });
            await expect(dropped).rejects.toThrow('The pairing link closed after the two words');
            // The code is spent and nothing was granted: no Try again, no pending key.
            await expect(dropped).rejects.toBeInstanceOf(PairingNeedsNewCode);
            expect(phone.secure.has(PENDING_LINK_KEY)).toBe(false);
        } finally {
            await abort();
            await pairing.catch(() => undefined);
        }
    }, 90_000);

    it('exits 2 asking for the person when a non-TTY caller runs the setup pairing step', async () => {
        // `muxr setup` (scripted) converges on startSelfHost -> mintDeviceGrant
        // -> linkPair, the same pairing step `muxr pair` uses. Service
        // registration is skipped under MUXR_NO_SERVICE_COMMANDS (the lab owns
        // the relay and host directly), so the setup path reaches the shared
        // non-TTY guard. launch() gives the child no TTY, the way an AI agent
        // or script runs it. Companion to the `muxr pair` non-TTY test.
        // Depends on the shared guard: red until it lands.
        const before = readFileSync(join(home, 'selfhost.json'), 'utf8');
        const startedAt = Date.now();
        const child = launch([cliMain, 'self-host', '--port', String(port), '--advertise', `ws://127.0.0.1:${port}`]);
        const code = await new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)));
        const elapsedMs = Date.now() - startedAt;
        try {
            expect(elapsedMs).toBeLessThan(1_000);
            expect(code).toBe(2);
            const lines = child.output().trim().split('\n');
            expect(lines[lines.length - 1]).toBe('Pairing needs you at this computer\'s terminal: run `muxr pair` yourself');
            expect(child.output()).not.toContain('byokit-link:');
        } finally {
            writeFileSync(join(home, 'selfhost.json'), before);
        }
    }, 30_000);
});
