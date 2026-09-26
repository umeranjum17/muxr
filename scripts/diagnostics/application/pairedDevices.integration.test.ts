/**
 * What a paired phone lives through, end to end, on the phone's own code.
 *
 * Step 4 of the byokit migration moved native pairing onto the link, so this
 * flow pairs every phone the way `muxr pair` now does: the computer runs the
 * real `linkPair` (its own pairing host, approval on the computer), and the
 * phone runs the real `pairOverLink` against the real relay and self-host
 * host. Pair two phones and a second machine, restart everything from disk,
 * then revoke one phone. Nothing here may need a re-pair except the revoked
 * phone, and every phone drives sessions over the machine's link with no
 * relay credential at all.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { DeviceLink, hostId, keyPair as linkKeyPair, pairWithOffer, type DeviceGrant } from '@byokit/link';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { waitForRelay } from './waitForRelay.mjs';
import { linkPair, machineLinkUrl, readSelfhostState } from '../../setup/index.mjs';
import { machineIdentity } from '../../setup/index.mjs';
import type { StoredHostedGrant } from '../../../apps/mobile/sources/pairing/application/hostedE2ee.js';

interface Phone { os: 'android' | 'ios'; secure: Map<string, string>; local: Map<string, string> }

vi.mock('expo-device', () => ({ isDevice: true }));

const repoRoot = join(import.meta.dirname, '../../..');
const children = new Set<ChildProcess>();
const scratch: string[] = [];
const PENDING_LINK_KEY = 'muxr.hosted-e2ee.pending-link-pair.v1';

// A live deployment exports these; inherited, they aim the lab at real services.
const labEnv = (home: string): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, MUXR_HOME: home, MUXR_NO_SERVICE_COMMANDS: '1' };
    for (const key of ['RELAY_TOKEN', 'RELAY_URL', 'MACHINE_ID', 'RELAY_AUTH', 'RELAY_PORT', 'MODE', 'DATA_DIR']) delete env[`MUXR_${key}`];
    return env;
};

function launch(args: string[], env: NodeJS.ProcessEnv): ChildProcess & { output: () => string } {
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

/** One computer as `muxr setup` leaves it: its own relay, host and ~/.muxr. */
class Machine {
    readonly home = mkdtempSync(join(tmpdir(), 'muxr-paired-devices-'));
    port = 0;
    id = '';
    private relay: ChildProcess | undefined;
    private host: (ChildProcess & { output: () => string }) | undefined;

    constructor(readonly name: string) { scratch.push(this.home); }

    async start(): Promise<void> {
        const restarting = this.id !== '';
        const storedPort = restarting ? JSON.parse(readFileSync(join(this.home, 'selfhost.json'), 'utf8')).relayPort as number : 0;
        for (let attempt = 0; ; attempt++) {
            const relay = launch([join(repoRoot, 'apps/relay/dist/main.js')], {
                ...labEnv(this.home),
                MUXR_RELAY_PORT: String(storedPort),
                MUXR_RELAY_HOST: '127.0.0.1',
                MUXR_RELAY_DATA_DIR: join(this.home, 'relay'),
                MUXR_RELAY_MDNS: '0',
            });
            this.relay = relay;
            try {
                const port = await waitForRelay(relay);
                if (restarting && port !== storedPort) throw new Error(`relay restarted on ${port}, expected ${storedPort}`);
                this.port = port;
                break;
            } catch (error) {
                if (!restarting || attempt === 2 || relay.exitCode === null && relay.signalCode === null) throw error;
                await new Promise((resolve) => setTimeout(resolve, 150));
            }
        }
        if (!restarting) {
            const machine = { ...machineIdentity(undefined), name: this.name };
            this.id = machine.id;
            writeFileSync(join(this.home, 'selfhost.json'), `${JSON.stringify({
                version: 1,
                machine,
                relayPort: this.port,
                relayUrl: `ws://127.0.0.1:${this.port}`,
                relayLocation: 'local',
                relayRole: 'single-machine',
                connectionMode: 'lan',
                webEnabled: false,
                mintSecret: JSON.parse(readFileSync(join(this.home, 'relay', 'mint-secret'), 'utf8')),
            }, null, 2)}\n`, { mode: 0o600 });
        }
        const host = launch([join(repoRoot, 'apps/host/dist/main.js'), '--fake'], { ...labEnv(this.home), MUXR_MODE: 'selfhost' });
        this.host = host;
        await until(() => (host.output().includes('host -> ') ? true : undefined), `${this.name} host start`);
    }

    async stop(): Promise<void> {
        await stop(this.host);
        await stop(this.relay);
    }

    cli(args: string[]): ChildProcess & { output: () => string } {
        return launch([join(repoRoot, 'scripts/cli.mjs'), ...args], labEnv(this.home));
    }

    async run(args: string[]): Promise<string> {
        const child = this.cli(args);
        const code = await new Promise((resolve) => child.once('exit', resolve));
        if (code !== 0) throw new Error(`muxr ${args.join(' ')} exited ${code}: ${child.output().slice(-400)}`);
        return child.output();
    }

    /**
     * `muxr pair` for a native phone: the real `linkPair` runs in this
     * process against this machine's state, with the approval answered here
     * the way the terminal prompt answers it. Resolves with the offer once
     * the QR is on screen; `done` settles when the phone's proof lands.
     */
    async pairNative(approve?: (req: { name: string; words: string }) => boolean): Promise<{ offer: string; done: Promise<Record<string, unknown>>; abort: () => void }> {
        let out = '';
        const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true; });
        const previousHome = process.env.MUXR_HOME;
        process.env.MUXR_HOME = this.home;
        const controller = new AbortController();
        const done = linkPair(readSelfhostState(), {
            approve: async (req) => approve?.(req) ?? true,
            signal: controller.signal,
        }).finally(() => {
            spy.mockRestore();
            if (previousHome === undefined) delete process.env.MUXR_HOME;
            else process.env.MUXR_HOME = previousHome;
        });
        const offer = await until(() => /byokit-link:1:[A-Za-z0-9_-]+/.exec(out)?.[0], 'link offer on screen');
        return { offer, done, abort: () => controller.abort() };
    }
}

/**
 * A fresh module graph over the phone's persisted stores is an app launch:
 * nothing survives in memory, everything the phone knows comes off its disk.
 */
async function launchApp(phone: Phone) {
    vi.resetModules();
    vi.doMock('react-native', () => ({
        Platform: { OS: phone.os },
        AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
    }));
    vi.doMock('expo-device', () => ({ isDevice: true }));
    vi.doMock('expo-secure-store', () => ({
        getItemAsync: async (key: string) => phone.secure.get(key) ?? null,
        setItemAsync: async (key: string, value: string) => { phone.secure.set(key, value); },
        deleteItemAsync: async (key: string) => { phone.secure.delete(key); },
    }));
    vi.doMock('@react-native-async-storage/async-storage', () => ({
        default: {
            getItem: async (key: string) => phone.local.get(key) ?? null,
            setItem: async (key: string, value: string) => { phone.local.set(key, value); },
            removeItem: async (key: string) => { phone.local.delete(key); },
        },
    }));
    const hosted = await import('../../../apps/mobile/sources/pairing/application/hostedE2ee.js');
    return {
        ...hosted,
        /** The machine link the way the session layer dials it: derived from the stored grant. */
        async open(machine: Machine): Promise<{ link: DeviceLink }> {
            const grant = await hosted.loadHostedGrant(machine.id);
            if (grant === undefined) throw new Error(`phone has no grant for ${machine.id}`);
            const link = new DeviceLink({
                v: 1,
                secretKey: Buffer.from(grant.deviceKey.secretKey, 'base64').toString('base64url'),
                host: Buffer.from(grant.machineBoxPublicKey, 'base64').toString('base64url'),
                hostName: grant.machineName ?? machine.name,
                urls: [machineLinkUrl(`ws://127.0.0.1:${machine.port}`, grant.machineBoxPublicKey)],
                device: { id: 'pending', name: 'Phone', role: 'control' },
            }, { WebSocket: WebSocket as never });
            link.connect();
            await until(() => (link.status === 'online' ? true : undefined), `phone reaches ${machine.id} over the link`, 30_000);
            return { link };
        },
    };
}

async function pairPhone(phone: Phone, machine: Machine) {
    const { offer, done } = await machine.pairNative();
    const app = await launchApp(phone);
    const grant = await app.pairOverLink(offer);
    expect(await done).toMatchObject({ deviceId: grant.deviceId, devicePublicKey: grant.devicePublicKey });
    return grant;
}

/**
 * The app dies the moment the computer approves the pairing, before it holds
 * the machine details. What it had written by then — its key and the scanned
 * offer — is all the relaunched app gets, and that must finish the pairing
 * rather than strand a device the machine now lists.
 */
async function pairThroughAppDeath(phone: Phone, machine: Machine): Promise<Phone> {
    const { offer, done } = await machine.pairNative();
    const app = await launchApp(phone);
    // Seed exactly what `pairOverLink` persists before it first connects,
    // then claim the offer as the phone does — approved, and then dead.
    const kp = linkKeyPair();
    phone.secure.set(PENDING_LINK_KEY, JSON.stringify({
        scanned: offer,
        name: 'Android phone',
        secretKey: Buffer.from(kp.secretKey).toString('base64url'),
    }));
    await pairWithOffer(offer, { name: 'Android phone', key: kp, onWords: () => undefined });
    const onDiskAtDeath = await until(() => (phone.secure.has(PENDING_LINK_KEY)
        ? { os: phone.os, secure: new Map(phone.secure), local: new Map(phone.local) }
        : undefined), 'pending pairing persisted', 20_000);
    expect([...onDiskAtDeath.secure.keys()].some((key) => key.startsWith('muxr.grant.'))).toBe(false);
    const relaunched = await launchApp(onDiskAtDeath);
    const resumed = await relaunched.resumePendingHostedPairing();
    expect(resumed).toMatchObject({ machineId: machine.id, authority: 'control', source: 'selfhost' });
    expect(onDiskAtDeath.secure.has(PENDING_LINK_KEY)).toBe(false);
    expect(await done).toMatchObject({ deviceId: resumed!.deviceId });
    return onDiskAtDeath;
}

/** The machine link the stored grant drives, derived the way the session layer does. */
function linkFor(grant: StoredHostedGrant, machine: Machine): DeviceLink {
    return new DeviceLink({
        v: 1,
        secretKey: Buffer.from(grant.deviceKey.secretKey, 'base64').toString('base64url'),
        host: Buffer.from(grant.machineBoxPublicKey, 'base64').toString('base64url'),
        hostName: grant.machineName ?? machine.name,
        urls: [machineLinkUrl(`ws://127.0.0.1:${machine.port}`, grant.machineBoxPublicKey)],
        device: { id: 'pending', name: 'Phone', role: 'control' },
    } satisfies DeviceGrant, { WebSocket: WebSocket as never });
}

describe('paired devices across pairing, restarts and revoke', () => {
    afterAll(async () => {
        vi.unstubAllGlobals();
        await Promise.all([...children].map((child) => stop(child)));
        for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
    });

    it('keeps every paired phone and machine through restarts, and cuts off only the revoked phone', async () => {
        vi.stubGlobal('WebSocket', WebSocket);
        const desk = new Machine('Desk');
        const laptop = new Machine('Laptop');
        await Promise.all([desk.start(), laptop.start()]);
        const iphone: Phone = { os: 'ios', secure: new Map(), local: new Map() };

        // The Android phone's app dies mid-pairing and resumes; the iPhone
        // pairs the desk, then pairs the laptop from the same phone. Each
        // grant is control access, pinned to the machine key the offer carried.
        const android = await pairThroughAppDeath({ os: 'android', secure: new Map(), local: new Map() }, desk);
        const androidDesk = await (await launchApp(android)).loadHostedGrant(desk.id);
        expect(androidDesk).toMatchObject({ machineId: desk.id, authority: 'control', source: 'selfhost', machineName: 'Desk' });
        expect(androidDesk?.relayUrl).toBe(`ws://127.0.0.1:${desk.port}`);
        const iphoneDesk = await pairPhone(iphone, desk);
        expect(iphoneDesk).toMatchObject({ machineId: desk.id, authority: 'control' });
        await pairPhone(iphone, laptop);
        const listed = await desk.run(['devices', 'list']);
        expect(listed).toContain('Android phone');
        expect(listed).toContain('iPhone');

        // Both phones drive the desk over its link, and the iPhone drives
        // both machines.
        let app = await launchApp(android);
        let androidLink = await app.open(desk);
        const started = await androidLink.link.request('session.start', { type: 'session.start', requestId: 'r1', params: { cwd: desk.home } }) as {
            type: string; ok: boolean; data?: { info?: { id?: string } };
        };
        expect(started).toMatchObject({ type: 'result', ok: true });
        const sessionId = started.data?.info?.id;
        expect(typeof sessionId).toBe('string');
        expect((await androidLink.link.request('client.hello', { type: 'client.hello', clientId: 'android' }) as { type: string; sessions: { id: string }[] }).sessions.map((session) => session.id)).toContain(sessionId);
        androidLink.link.stop();
        app = await launchApp(iphone);
        expect((await app.listPairedGrants()).map((grant) => grant.machineId).sort()).toEqual([desk.id, laptop.id].sort());
        for (const machine of [desk, laptop]) {
            const link = await app.open(machine);
            await link.link.request('client.hello', { type: 'client.hello', clientId: 'iphone' });
            link.link.stop();
        }

        // Restart both computers from disk and relaunch the apps: the stored
        // grants still open every machine, with no pairing step anywhere.
        await Promise.all([desk.stop(), laptop.stop()]);
        await Promise.all([desk.start(), laptop.start()]);
        app = await launchApp(android);
        androidLink = await app.open(desk);
        await androidLink.link.request('client.hello', { type: 'client.hello', clientId: 'android' });
        app = await launchApp(iphone);
        const iphoneLink = await app.open(desk);
        await iphoneLink.link.request('client.hello', { type: 'client.hello', clientId: 'iphone' });
        const laptopLink = await app.open(laptop);
        await laptopLink.link.request('client.hello', { type: 'client.hello', clientId: 'iphone' });
        laptopLink.link.stop();

        // Revoking the Android phone drops its live link and stops it for
        // good. The iPhone on the same machine is not asked to pair again and
        // keeps answering.
        await desk.run(['devices', 'revoke', 'Android phone']);
        expect(await desk.run(['devices', 'list'])).not.toContain('Android phone');
        await until(() => (androidLink.link.status === 'removed' ? true : undefined), 'revoked phone is removed from the link', 60_000);
        await until(async () => {
            try {
                await iphoneLink.link.request('client.hello', { type: 'client.hello', clientId: 'iphone' });
                return true;
            } catch {
                return undefined;
            }
        }, 'surviving phone keeps answering after the revoke', 30_000);
        androidLink.link.stop();
        iphoneLink.link.stop();
    }, 180_000);
});
