/**
 * What a paired phone lives through, end to end, on the phone's own code.
 *
 * The other pairing checks claim with the shared crypto module, and the phone's
 * client specs run against a fake socket. Nothing drove the phone's real claim,
 * grant store and encrypted client against the real `muxr pair`, relay and
 * self-host host together, so a change under the link could keep every check
 * green while paired phones stopped connecting. This flow is that lock: pair
 * two phones and a second machine, restart everything from disk, then revoke
 * one phone. Nothing here may need a re-pair except the revoked phone.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { waitForRelay } from './waitForRelay.mjs';
import { machineIdentity } from '../../setup/index.mjs';

interface Phone { os: 'android' | 'ios'; secure: Map<string, string>; local: Map<string, string> }

vi.mock('expo-device', () => ({ isDevice: true }));

const repoRoot = join(import.meta.dirname, '../../..');
const children = new Set<ChildProcess>();
const scratch: string[] = [];

// A live deployment exports these; inherited, they aim the lab at real services.
const labEnv = (home: string): NodeJS.ProcessEnv => {
    const env = { ...process.env, MUXR_HOME: home, MUXR_NO_SERVICE_COMMANDS: '1' };
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

    /** `muxr pair`, and the string it prints for a camera or a keyboard. */
    async pairingString(): Promise<{ text: string; pair: ChildProcess & { output: () => string } }> {
        const pair = this.cli(['pair']);
        const printed = await until(() => /Pairing string \(expires in two minutes\):\s*(\S+)/.exec(pair.output())?.[1], 'muxr pair string');
        return { text: printed, pair };
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
    const { MuxrClient } = await import('../../../apps/mobile/sources/pairing/infrastructure/muxrClient.js');
    return {
        ...hosted,
        /** Open the machine the way the app does: stored grant, its relay, its credential. */
        async open(machine: Machine) {
            const machineId = machine.id;
            const grant = await hosted.loadHostedGrant(machineId);
            if (grant === undefined) throw new Error(`phone has no grant for ${machineId}`);
            const permanentErrors: string[] = [];
            const client = new MuxrClient({
                mode: 'hosted',
                relayUrl: grant.relayUrl,
                machineId,
                token: grant.credential,
                hostedGrant: grant,
                requestTimeoutMs: 5_000,
                onPermanentError: (message) => permanentErrors.push(message),
            });
            client.connect();
            await until(() => (client.state === 'open' ? true : undefined), `phone reaches ${machineId}`);
            return { client, permanentErrors };
        },
    };
}

async function pairPhone(phone: Phone, machine: Machine, typed = false) {
    const { text, pair } = await machine.pairingString();
    const app = await launchApp(phone);
    // Typed: the same string, with the whitespace a person pastes around it.
    const grant = await app.claimHostedPairing(typed ? `  ${text}\n` : text);
    await until(() => (pair.exitCode === null ? undefined : pair.exitCode), 'muxr pair finishes after the claim');
    expect(pair.exitCode, pair.output()).toBe(0);
    expect(pair.output()).toContain('paired and verified');
    return grant;
}

/**
 * The app dies the moment its one-shot claim is accepted, before it holds a
 * grant. What it had written by then is all the relaunched app gets, and that
 * must finish the pairing rather than strand a device the machine now lists.
 */
async function pairThroughAppDeath(phone: Phone, machine: Machine): Promise<Phone> {
    const { text, pair } = await machine.pairingString();
    const app = await launchApp(phone);
    const claiming = app.claimHostedPairing(text);
    const onDiskAtDeath = await until(() => (phone.secure.has('muxr.hosted-e2ee.pending-pair.v1')
        ? { os: phone.os, secure: new Map(phone.secure), local: new Map(phone.local) }
        : undefined), 'claim persisted before the grant wait', 20_000);
    expect([...onDiskAtDeath.secure.keys()].some((key) => key.startsWith('muxr.grant.'))).toBe(false);
    // The dead process is gone; let its orphaned wait settle before relaunching.
    await claiming;
    await until(() => (pair.exitCode === null ? undefined : pair.exitCode), 'muxr pair finishes after the claim');
    expect(pair.exitCode, pair.output()).toBe(0);
    const relaunched = await launchApp(onDiskAtDeath);
    const resumed = await relaunched.resumePendingHostedPairing();
    expect(resumed).toMatchObject({ machineId: machine.id, authority: 'control', source: 'selfhost' });
    expect(onDiskAtDeath.secure.has('muxr.hosted-e2ee.pending-pair.v1')).toBe(false);
    return onDiskAtDeath;
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

        // Scanned QR on one phone (whose app dies mid-claim), typed string on
        // the other; the iPhone also pairs a second machine. Each grant is
        // control access to the scanned machine, pinned to the machine key the
        // string carried.
        const android = await pairThroughAppDeath({ os: 'android', secure: new Map(), local: new Map() }, desk);
        const androidDesk = await (await launchApp(android)).loadHostedGrant(desk.id);
        expect(androidDesk).toMatchObject({ machineId: desk.id, authority: 'control', source: 'selfhost', machineName: 'Desk' });
        expect(androidDesk?.relayUrl).toBe(`ws://127.0.0.1:${desk.port}`);
        const iphoneDesk = await pairPhone(iphone, desk, true);
        expect(iphoneDesk).toMatchObject({ machineId: desk.id, authority: 'control' });
        await pairPhone(iphone, laptop);
        const listed = await desk.run(['devices', 'list']);
        expect(listed).toContain('Android phone');
        expect(listed).toContain('iPhone');

        // Both phones drive the desk, and the iPhone drives both machines.
        let app = await launchApp(android);
        let androidLink = await app.open(desk);
        const started = await androidLink.client.request('session.start', { cwd: desk.home });
        if (!('info' in started)) throw new Error(`session.start failed: ${JSON.stringify(started)}`);
        expect((await androidLink.client.request('session.list', {})).map((session) => session.id)).toContain(started.info.id);
        const androidApp = app;
        app = await launchApp(iphone);
        await androidLink.client.request('session.list', {});
        await androidApp.flushReplay();
        expect(android.local.has('muxr.hosted-e2ee.replay.v2')).toBe(true);
        expect(iphone.local.has('muxr.hosted-e2ee.replay.v2')).toBe(false);
        androidLink.client.close();
        expect((await app.listPairedGrants()).map((grant) => grant.machineId).sort()).toEqual([desk.id, laptop.id].sort());
        for (const machine of [desk, laptop]) {
            const link = await app.open(machine);
            await link.client.request('session.list', {});
            link.client.close();
        }

        // Restart both computers from disk and relaunch the apps: the stored
        // grants still open every machine, with no pairing step anywhere.
        await Promise.all([desk.stop(), laptop.stop()]);
        await Promise.all([desk.start(), laptop.start()]);
        app = await launchApp(android);
        androidLink = await app.open(desk);
        await androidLink.client.request('session.list', {});
        app = await launchApp(iphone);
        const iphoneLink = await app.open(desk);
        await iphoneLink.client.request('session.list', {});
        const laptopLink = await app.open(laptop);
        await laptopLink.client.request('session.list', {});
        laptopLink.client.close();

        // Revoking the Android phone drops its live link and stops it for good,
        // with a message that says why. The iPhone on the same machine is not
        // asked to pair again and keeps answering.
        await desk.run(['devices', 'revoke', 'Android phone']);
        expect(await desk.run(['devices', 'list'])).not.toContain('Android phone');
        await until(() => (androidLink.client.state === 'stale' ? true : undefined), 'revoked phone goes stale', 60_000);
        expect(androidLink.permanentErrors.join(' ')).toMatch(/revoked/);
        await until(async () => {
            try {
                await iphoneLink.client.request('session.list', {});
                return true;
            } catch {
                return undefined;
            }
        }, 'surviving phone keeps answering after the revoke', 30_000);
        androidLink.client.close();
        iphoneLink.client.close();
    }, 180_000);
});
