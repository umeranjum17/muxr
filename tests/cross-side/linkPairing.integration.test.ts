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
 * approval, an approval the code runs out before (both sides say so, and a
 * late yes pairs nothing), a phone that resumes by key after dying between approval and
 * completion, each lost acknowledgement settled by retrying the same code, and
 * a Tailscale address that does not answer naming which end to fix.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import {
    DeviceLink,
    LinkError,
    LINK_WORDS,
    b64url,
    COMPACT_TAG,
    encodeCompactOffer,
    hostId,
    keyPair,
    offerText,
    parseOffer,
    pairWithOffer,
    type DeviceGrant,
    type LinkStatus,
} from '@byokit/pair';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cliMain, hostMain, hostRoot, pairingIntent, relayMain, waitForRelay } from './host.js';
import { machineIdentity } from './hostSetup.js';
import type { StoredHostedGrant } from '../../apps/mobile/sources/pairing/application/linkPairing.js';
import { LinkFirstClient } from '../../apps/mobile/sources/pairing/infrastructure/linkFirstClient.js';
import { claimLinkPairing, type LinkPairPending } from '../../apps/mobile/sources/pairing/infrastructure/linkPairClient.js';
import { SESSION_EVENT_TYPES, type SessionEvent } from '@trymuxr/contract';
import { decidePairingInput, parsePairingString } from '../../apps/mobile/sources/pairing/domain/pairingString.js';

const home = mkdtempSync(join(tmpdir(), 'muxr-link-pairing-'));
process.env.MUXR_HOME = home;
const children = new Set<ChildProcess>();

const phone = vi.hoisted(() => ({ secure: new Map<string, string>(), web: new Map<string, string>(), local: new Map<string, string>(), platform: 'android' as 'android' | 'web', tailscale: undefined as boolean | undefined }));

vi.mock('react-native', () => ({
    Platform: { get OS() { return phone.platform; } },
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock('expo-device', () => ({ isDevice: true }));
vi.mock('../../apps/mobile/modules/tailnet-address', () => ({ hasTailnetAddress: () => phone.tailscale }));
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

function launch(args: string[], extra: NodeJS.ProcessEnv = {}, cwd = hostRoot): ChildProcess & { output: () => string } {
    const env: NodeJS.ProcessEnv = { ...process.env, MUXR_HOME: home, MUXR_NO_SERVICE_COMMANDS: '1', ...extra };
    for (const key of ['RELAY_TOKEN', 'RELAY_URL', 'MACHINE_ID', 'RELAY_AUTH', 'DATA_DIR']) delete env[`MUXR_${key}`];
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    await startHost();
}

async function startHost(pairMs?: string): Promise<void> {
    await stop(host);
    rmSync(join(home, 'host', 'pair.sock'), { force: true });
    host = launch([hostMain, '--fake'], { MUXR_MODE: 'selfhost', ...(pairMs === undefined ? {} : { MUXR_PAIR_CODE_MS: pairMs }) });
    const running = host;
    await until(() => (existsSync(join(home, 'host', 'pair.sock')) ? true : undefined), `host pairing socket (${running.output()})`);
}

/** Options `linkPair` on the computer side accepts (untyped .mjs import). */
interface ComputerPairingOptions {
    approve?: (req: { name: string; words: string }, signal: AbortSignal) => boolean | Promise<boolean>;
    signal?: AbortSignal;
    intent?: ReturnType<typeof pairingIntent>;
}

function offersOn(text: string): string[] {
    const pattern = new RegExp(`(?:https?:\\/\\/[^\\s]+\\/pair#)?(?:byokit-link:1:[A-Za-z0-9_-]+|${COMPACT_TAG}[A-Za-z0-9_-]+)`, 'g');
    return [...text.matchAll(pattern)].map((match) => match[0]);
}

/** Starts a computer pairing and resolves once its QR is on screen. */
async function showPairingQr(options: Omit<ComputerPairingOptions, 'signal'>, ttySize?: { columns: number; rows: number }): Promise<{
    pairing: Promise<unknown>;
    offer: string;
    output: () => string;
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
    const offer = await until(() => offersOn(out)[0], 'pairing offer on screen', 30_000)
        .catch(async (error: unknown) => { await stop(); throw error; });
    return { pairing, offer, output: () => out, abort: stop };
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

    it('pairs the first phone through the kit files after wrong words, a cancelled peer reset and a code that ran out, then refuses a second handoff', async () => {
        const workDir = join(home, 'kit-work');
        mkdirSync(workDir);
        const outbox = join(workDir, '.byokit', 'outbox');
        const inbox = join(workDir, '.byokit', 'inbox');
        // Same raw-byte, private, atomic rename contract as kit deliver.
        const deliver = (wordsFile: string, text: string) => {
            const wordsPath = join(inbox, wordsFile);
            writeFileSync(`${wordsPath}.tmp`, text, { mode: 0o600 });
            renameSync(`${wordsPath}.tmp`, wordsPath);
        };
        const nextOffer = (command: ChildProcess & { output: () => string }, previousWords?: string) => until(() => {
            if (command.exitCode !== null) throw new Error(command.output());
            const file = existsSync(outbox) ? readdirSync(outbox).find((name) => name.endsWith('.json')) : undefined;
            if (file === undefined) return undefined;
            const offerPath = join(outbox, file);
            const offered = JSON.parse(readFileSync(offerPath, 'utf8'));
            return offered.wordsFile === previousWords ? undefined : { offerPath, offered };
        }, 'handoff offer', 60_000);
        // Short codes let the matching run see one code run out before its yes.
        await startHost('20000');
        try {
            for (const mode of ['wrong', 'cancel', 'matching']) {
                const matches = mode === 'matching';
                const before = readSelfhostState().machine.crypto.devices.length;
                const command = launch([cliMain, 'pair', '--handoff'], { MUXR_DESKTOP_SOURCE: 'x11' }, workDir);
                const exited = new Promise<number | null>((resolve) => command.once('exit', resolve));
                let shownWords = '';
                try {
                    const { offerPath, offered } = await nextOffer(command);
                    expect(Buffer.byteLength(readFileSync(offerPath))).toBeLessThanOrEqual(64 * 1024);
                    expect(offered.version).toBe(1);
                    let current = offered;
                    if (matches) {
                        let lateWords = '';
                        await expect(runPhonePairing(offered.offer, { onWords: async (words) => { lateWords = words; } }))
                            .rejects.toBeInstanceOf(PairingNeedsNewCode);
                        current = (await nextOffer(command, offered.wordsFile)).offered;
                        // The first code's words arrive after it ran out; the next code's approval starts later.
                        deliver(offered.wordsFile, lateWords);
                        await new Promise((resolve) => setTimeout(resolve, 6_000));
                    }
                    const pairing = runPhonePairing(current.offer, { onWords: async (words) => {
                        shownWords = words;
                        if (mode === 'cancel') {
                            // Let the computer enter the actual SAS approval wait,
                            // then its CLI closes the local socket during cancel.
                            await new Promise((resolve) => setTimeout(resolve, 300));
                            command.kill('SIGTERM');
                            return;
                        }
                        deliver(current.wordsFile, matches ? words : 'wrong words');
                    } });
                    if (matches) await pairing;
                    else await expect(pairing).rejects.toThrow();
                    expect(await exited).toBe(matches ? 0 : 1);
                    expect(readSelfhostState().machine.crypto.devices.length).toBe(before + (matches ? 1 : 0));
                    expect(existsSync(offerPath)).toBe(false);
                    expect(existsSync(join(inbox, current.wordsFile))).toBe(false);
                    expect(command.output()).not.toContain(current.offer);
                    expect(shownWords).not.toBe('');
                    expect(command.output()).not.toContain(shownWords);
                    if (mode === 'wrong') expect(command.output()).toContain('two words did not match');
                    if (mode === 'cancel') {
                        await until(() => host!.output().includes('Pairing connection lost; this pairing attempt ended.') ? true : undefined,
                            'host contains the peer reset without crashing');
                        expect(host!.exitCode).toBeNull();
                        expect(host!.signalCode).toBeNull();
                        expect(host!.output().match(/Pairing connection lost; this pairing attempt ended\./g)).toHaveLength(1);
                    }
                } finally { await stop(command); }
            }
        } finally {
            await startHost();
        }

        const second = launch([cliMain, 'pair', '--handoff'], { MUXR_DESKTOP_SOURCE: 'x11' }, workDir);
        const secondExited = new Promise<number | null>((resolve) => second.once('exit', resolve));
        try {
            expect(await secondExited).toBe(1);
            expect(second.output()).toContain('Handoff pairing is only for the first device');
            expect(readSelfhostState().machine.crypto.devices.length).toBe(1);
            expect(existsSync(outbox) ? readdirSync(outbox) : []).toEqual([]);
        } finally { await stop(second); }
    }, 120_000);

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
            // The app's own pair screen decides the input, then pairs the value
            // it hands the transport: `link`, not the unwrapped `offer` — the
            // browser wrapper is what `assertSupportedOffer` accepts on web.
            const decided = decidePairingInput(offer);
            expect(decided.ok).toBe(true);
            if (!decided.ok) return;
            const stored = await runPhonePairing(decided.link, { onWords: (words) => { browserWords = words; } });
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

    it('pairs an http-wrapped paste, the shape a plain-ws relay prints', async () => {
        const { pairing, offer } = await showPairingQr({ approve: () => true });
        // `muxr pair --browser` prints exactly this wrapper when the relay
        // advertises plain ws:// — webOrigin is then undefined and the base
        // falls back to relayUrl with ws→http (linkPair.mjs). The phone
        // pastes it into Pair; only the token in the fragment pairs.
        const wrapped = `http://127.0.0.1:${port}/pair#${offer}`;
        const decided = decidePairingInput(wrapped);
        expect(decided).toMatchObject({ ok: true, offer });
        if (!decided.ok) return;
        let phoneWords = '';
        const stored = await runPhonePairing(decided.link, { onWords: (words) => { phoneWords = words; } });
        await pairing;
        expect(phoneWords).not.toBe('');
        expect(readSelfhostState().machine.crypto.devices.some((device) => device.deviceId === stored.deviceId)).toBe(true);
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

    it('says which end to fix when the computer\'s Tailscale address does not answer', async () => {
        const cases = [
            { tailscale: false, says: "Can't reach Desk: turn on Tailscale on this phone and sign in, then try again." },
            { tailscale: true, says: "Can't reach Desk: check it's awake and Tailscale is on there, signed in to the same account as this phone." },
            { tailscale: undefined, says: "Can't reach Desk. Is it awake and is Tailscale connected on this phone and the computer?" },
        ];
        for (const { tailscale, says } of cases) {
            const { pairing, offer, abort } = await showPairingQr({ approve: () => true });
            phone.tailscale = tailscale;
            try {
                // The computer advertises a MagicDNS name nothing answers on.
                const payload = JSON.parse(Buffer.from(offer.slice('byokit-link:1:'.length), 'base64url').toString('utf8')) as { urls: string[] };
                payload.urls = payload.urls.map((url) => url.replace(`${advertisedAddress}:${port}`, 'desk.tail-unused.ts.net:1'));
                const unreachable = runPhonePairing(`byokit-link:1:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`);
                await expect(unreachable).rejects.toThrow(says);
                // Nothing was claimed, so Try again stays on this code.
                await expect(unreachable).rejects.not.toBeInstanceOf(PairingNeedsNewCode);
                expect(phone.secure.has(PENDING_LINK_KEY)).toBe(false);
            } finally {
                phone.tailscale = undefined;
                await abort();
                await pairing.catch(() => undefined);
            }
        }
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
            await expect(retry).rejects.toThrow("This pairing didn't finish on your computer. Get a new code from muxr there and scan it.");
            expect((await loadHostedGrant(machineId))?.deviceId).toBe(kept?.deviceId);
            expect(phone.secure.has(PENDING_LINK_KEY)).toBe(false);
        } finally {
            // A failed step must not wedge the computer's one pairing slot.
            await qr.abort();
        }
    }, 120_000);

    it('pairs nothing when the person at the computer declines', async () => {
        const before = readSelfhostState().machine.crypto.devices.length;
        const { pairing, offer, abort } = await showPairingQr({ approve: async () => false });
        try {
            await expect(runPhonePairing(offer)).rejects.toThrow('Your computer said no to this device.');
            // The computer has replaced the spent code; the old one says to use the new one.
            const superseded = runPhonePairing(offer);
            await expect(superseded).rejects.toBeInstanceOf(PairingNeedsNewCode);
            await expect(superseded).rejects.toThrow('The code ran out. Scan the new QR on your computer');
            expect(readSelfhostState().machine.crypto.devices).toHaveLength(before);
            await abort();
            await expect(pairing).rejects.toThrow('cancelled');
        } catch (error) {
            // A failed step must not hold the computer's one pairing slot.
            await abort();
            throw error;
        }
        expect(phone.secure.has(PENDING_LINK_KEY)).toBe(false);
    }, 90_000);

    describe('a code that runs out', () => {
        // Only this journey shortens the code; the shared host keeps the production length.
        beforeAll(() => startHost('20000'));
        afterAll(() => startHost());

        it('says the code ran out, not declined, and a late yes pairs nothing', async () => {
            const before = readSelfhostState().machine.crypto.devices.length;
            const prompts: ((yes: boolean) => void)[] = [];
            // The person never answers in time; the prompt ignores the abort so a yes can still arrive late.
            const { pairing, offer, output, abort } = await showPairingQr({ approve: () => new Promise<boolean>((resolve) => { prompts.push(resolve); }) });
            let nextPairing: Promise<unknown> | undefined;
            try {
                const refused = runPhonePairing(offer);
                await expect(refused).rejects.toBeInstanceOf(PairingNeedsNewCode);
                await expect(refused).rejects.toThrow('The code ran out. Scan the new QR on your computer');
                // The computer closes the prompt and shows a new code with the notice above it.
                await until(() => (output().includes('That code ran out before you said yes. Scan the new QR below') ? true : undefined), 'ran-out notice on the computer', 30_000);
                // The same code again is refused on the phone before it reaches the computer, as the offer's own expiry.
                const spent = runPhonePairing(offer);
                await expect(spent).rejects.toThrow('That pairing code has run out. Open muxr on your computer, or run muxr pair, for a new one.');
                const nextOffer = await until(() => offersOn(output()).find((text) => text !== offer), 'next pairing offer', 30_000);
                let nextDone = false;
                nextPairing = runPhonePairing(nextOffer, { onWords: async () => undefined });
                nextPairing.then(() => { nextDone = true; }, () => undefined);
                await until(() => (prompts.length === 2 ? true : undefined), 'approval for the next code', 30_000);
                prompts[0]!(true);
                await new Promise((resolve) => setTimeout(resolve, 2_000));
                expect(nextDone).toBe(false);
                expect(readSelfhostState().machine.crypto.devices).toHaveLength(before);
            } finally {
                await abort();
                await pairing.catch(() => undefined);
                await nextPairing?.catch(() => undefined);
            }
        }, 90_000);
    });

    it('exits 2 asking for the person when a non-TTY caller runs muxr pair', async () => {
        // launch() gives the child no TTY, the way an AI agent or script does.
        const startedAt = Date.now();
        const child = launch([cliMain, 'pair']);
        const code = await new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)));
        const elapsedMs = Date.now() - startedAt;
        expect(elapsedMs).toBeLessThan(10_000);
        expect(code).toBe(2);
        expect(child.output().trim()).toBe('Pairing needs you at this computer\'s terminal: run `muxr pair` yourself');
    });

    it('completes a pairing for a phone that died between approval and the machine details', async () => {
        const { pairing, offer, abort } = await showPairingQr({ approve: async () => true });
        try {
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
        } catch (error) {
            // A failed step must not hold the computer's one pairing slot.
            await abort();
            throw error;
        }
    }, 90_000);


    it('lists and revokes a link-paired phone from the host record', async () => {
        const state = readSelfhostState();
        const paired = state.machine.crypto.devices;
        expect(paired).toHaveLength(8);
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
        // the full v1 QR (37 rows), so the pairing string on screen is the
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

    it('resumes a phone killed after the words and before approval, for a v1 and a compact offer, and refuses a different computer', async () => {
        const machineId = readSelfhostState().machine.id;
        // Model the phone process dying: the kit's sockets close mid-pairing,
        // so the host sees the device gone while the person is still deciding.
        const live = new Set<WebSocket>();
        class KillableWebSocket extends WebSocket {
            constructor(url: string | URL, protocols?: string | string[]) {
                super(url, protocols);
                live.add(this);
                this.once('close', () => live.delete(this));
            }
        }
        const killPhone = (): void => { for (const socket of live) socket.terminate(); live.clear(); };
        const baseWebSocket = globalThis.WebSocket;
        try {
            for (const compact of [false, true]) {
                phone.secure.delete(PENDING_LINK_KEY);
                let words = '';
                let approveNow: () => void = () => undefined;
                const waiting = new Promise<void>((resolve) => { approveNow = resolve; });
                const { pairing, offer, abort } = await showPairingQr({
                    approve: async () => { await waiting; return true; },
                }, compact ? { columns: 120, rows: 30 } : undefined);
                try {
                    (globalThis as { WebSocket: typeof WebSocket }).WebSocket = KillableWebSocket as unknown as typeof WebSocket;
                    const claiming = runPhonePairing(offer, { onWords: (shown) => { words = shown; } });
                    claiming.catch(() => undefined);
                    await until(() => (words !== '' ? true : undefined), 'phone shows the words');
                    // onPending persisted the pinned host before approval, on both offer forms.
                    const durable = phone.secure.get(PENDING_LINK_KEY);
                    expect(durable, `compact=${compact} pending`).toBeDefined();
                    const pending = JSON.parse(durable!) as LinkPairPending;
                    expect(pending.host, `compact=${compact} pinned host`).toBeDefined();

                    // The code has run out by the time the phone relaunches:
                    // re-encode the same offer with a past lifetime so the
                    // resume must ignore it and still finish against the host.
                    const parsed = parseOffer(offer, 0);
                    const expired = 'code' in parsed
                        ? encodeCompactOffer({ ...parsed, expires: Date.now() - 1_000 })
                        : offerText({ ...parsed, expires: Date.now() - 1_000 });
                    const relaunch = JSON.stringify({ ...pending, scanned: expired });

                    // Kill the phone mid-claim, let the host observe it is gone,
                    // then approve: the host keeps the grant because the phone
                    // said it kept a pending one.
                    killPhone();
                    await claiming.catch(() => undefined);
                    await new Promise((resolve) => setTimeout(resolve, 300));
                    approveNow();
                    // Relaunch sees the durable pending the kill left; the
                    // in-process rejection path would have dropped it, which a
                    // real process kill never runs.
                    let stored: StoredHostedGrant | undefined;
                    for (let attempt = 0; attempt < 20 && stored === undefined; attempt += 1) {
                        phone.secure.set(PENDING_LINK_KEY, relaunch);
                        stored = await resumePendingHostedPairing();
                        if (stored === undefined) await new Promise((resolve) => setTimeout(resolve, 500));
                    }
                    expect(stored, `compact=${compact} resumed after expiry`).toBeDefined();
                    expect(stored!.machineId).toBe(machineId);
                    await pairing;
                    expect(phone.secure.has(PENDING_LINK_KEY)).toBe(false);

                    // A resume pinned to a different host key is refused, with
                    // the wrong-host cause rather than any other failure.
                    const wrong = { ...pending, scanned: expired, host: b64url(Buffer.alloc(32, compact ? 0x5a : 0x69)) };
                    phone.secure.set(PENDING_LINK_KEY, JSON.stringify(wrong));
                    await expect(claimLinkPairing(wrong, { mode: 'resume' })).rejects.toThrow(LINK_WORDS['wrong-host']);
                    expect(await resumePendingHostedPairing()).toBeUndefined();
                } finally {
                    await abort();
                    await pairing.catch(() => undefined);
                }
            }
        } finally {
            (globalThis as { WebSocket: typeof WebSocket }).WebSocket = baseWebSocket;
        }
    }, 180_000);

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
            expect(elapsedMs).toBeLessThan(10_000);
            expect(code).toBe(2);
            const lines = child.output().trim().split('\n');
            expect(lines[lines.length - 1]).toBe('Pairing needs you at this computer\'s terminal: run `muxr pair` yourself');
            expect(child.output()).not.toContain('byokit-link:');
        } finally {
            writeFileSync(join(home, 'selfhost.json'), before);
        }
    }, 30_000);
});
