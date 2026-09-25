/**
 * A phone paired before the link existed reaches its machine over the link.
 *
 * The phone pairs through its own claim code against the real `muxr pair`,
 * relay and self-host host. Then the machine restarts on a data directory with
 * no link state at all, which is what an upgrade from the old build looks
 * like: the host proves its existing machine key to its relay and enrols the
 * phone from its own device records. The keys the phone already stores open a
 * link session with no pairing step and no message to the phone, while the
 * relay transport keeps working beside it. Revoking the phone ends both.
 *
 * The relay is spawned on MUXR_RELAY_PORT=0 and its port read from
 * waitForRelay; the restart reuses the port recorded in selfhost.json, the
 * way a real self-host relay restarts.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { DeviceLink, hostId, type DeviceGrant, type LinkStatus } from '@byokit/link';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { waitForRelay } from './waitForRelay.mjs';
import { machineIdentity } from '../../setup/index.mjs';

const phone = vi.hoisted(() => ({ secure: new Map<string, string>(), local: new Map<string, string>() }));

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
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

import { claimHostedPairing, type StoredHostedGrant } from '../../../apps/mobile/sources/pairing/application/hostedE2ee.js';
import { MuxrClient } from '../../../apps/mobile/sources/pairing/infrastructure/muxrClient.js';

const repoRoot = join(import.meta.dirname, '../../..');
const home = mkdtempSync(join(tmpdir(), 'muxr-link-upgrade-'));
const children = new Set<ChildProcess>();

function launch(args: string[], extra: NodeJS.ProcessEnv = {}): ChildProcess & { output: () => string } {
    const env: NodeJS.ProcessEnv = { ...process.env, MUXR_HOME: home, MUXR_NO_SERVICE_COMMANDS: '1', ...extra };
    for (const key of ['RELAY_TOKEN', 'RELAY_URL', 'MACHINE_ID', 'RELAY_AUTH', 'DATA_DIR']) delete env[`MUXR_${key}`];
    if (extra.MUXR_RELAY_PORT === undefined) delete env.MUXR_RELAY_PORT;
    if (extra.MUXR_MODE === undefined) delete env.MUXR_MODE;
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

async function stopMachine(): Promise<void> {
    await stop(host);
    await stop(relay);
}

/** The keys a phone paired on the old build already stores, as a link grant. */
function linkGrantFrom(stored: StoredHostedGrant): DeviceGrant {
    const machineKey = Buffer.from(stored.machineBoxPublicKey, 'base64');
    return {
        v: 1,
        secretKey: Buffer.from(stored.deviceKey.secretKey, 'base64').toString('base64url'),
        host: machineKey.toString('base64url'),
        hostName: stored.machineName ?? 'Computer',
        urls: [`ws://127.0.0.1:${port}/link/v1/${hostId(machineKey)}`],
        device: { id: 'pending', name: 'Android phone', role: 'control' },
        pendingUntil: Number.MAX_SAFE_INTEGER,
    };
}

/** The machine's own record of the device is what the link endpoint enrols from. */
function setAuthority(deviceId: string, authority: 'observe' | 'control'): void {
    const path = join(home, 'selfhost.json');
    const state = JSON.parse(readFileSync(path, 'utf8')) as {
        machine: { crypto: { devices: { deviceId: string; authority?: 'observe' | 'control' }[] } };
    };
    for (const device of state.machine.crypto.devices) if (device.deviceId === deviceId) device.authority = authority;
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

describe('link upgrade for an already-paired phone', () => {
    afterAll(async () => {
        vi.unstubAllGlobals();
        await Promise.all([...children].map((child) => stop(child)));
        rmSync(home, { recursive: true, force: true });
    });

    it('opens a link session with the keys the phone already has, beside the relay transport, until revoked', async () => {
        vi.stubGlobal('WebSocket', WebSocket);
        await startMachine();
        const pair = launch([join(repoRoot, 'scripts/cli.mjs'), 'pair']);
        const text = await until(() => /Pairing string \(expires in two minutes\):\s*(\S+)/.exec(pair.output())?.[1], 'muxr pair string');
        const stored = await claimHostedPairing(text);
        await until(() => (pair.exitCode === null ? undefined : pair.exitCode), 'muxr pair finishes');
        expect(pair.exitCode, pair.output()).toBe(0);
        phone.secure.clear();
        vi.resetModules();
        const { claimHostedPairing: claimOther } = await import('../../../apps/mobile/sources/pairing/application/hostedE2ee.js');
        const secondPair = launch([join(repoRoot, 'scripts/cli.mjs'), 'pair']);
        const secondText = await until(() => /Pairing string \(expires in two minutes\):\s*(\S+)/.exec(secondPair.output())?.[1], 'second pair string');
        const other = await claimOther(secondText);
        await until(() => (secondPair.exitCode === null ? undefined : secondPair.exitCode), 'second pair finishes');
        expect(secondPair.exitCode, secondPair.output()).toBe(0);

        // The upgrade: same machine, same keys, a relay with no link state.
        await stopMachine();
        rmSync(join(home, 'relay', 'link-relay.json'), { force: true });
        await startMachine();

        const statuses: LinkStatus[] = [];
        const events: unknown[] = [];
        const link = new DeviceLink(linkGrantFrom(stored), {
            WebSocket: WebSocket as never,
            onStatus: (status) => statuses.push(status),
            onEvent: (event) => events.push(event),
        });
        await until(() => (link.status === 'online' ? true : undefined), 'already-paired phone comes online over the link', 30_000);
        expect(link.grant.device.id).not.toBe('pending');
        const started = await link.request('session.start', { type: 'session.start', requestId: 'r1', params: { cwd: home } }) as {
            type: string; ok: boolean; data?: { info?: { id?: string } };
        };
        expect(started).toMatchObject({ type: 'result', ok: true });
        const sessionId = started.data?.info?.id;
        expect(typeof sessionId).toBe('string');
        const wire = (link as unknown as { conn: { send: (message: unknown) => void } }).conn;
        const send = wire.send.bind(wire);
        let answered: { key: string; session: string; ack: number } | undefined;
        wire.send = (message) => {
            const request = message as { t?: string; op?: string; key?: string; session?: string; ack?: number };
            if (request.t === 'req' && request.op === 'client.hello' && answered === undefined) {
                answered = { key: request.key!, session: request.session!, ack: request.ack! };
            }
            send(message);
        };
        await expect(link.request('desktop.open', { type: 'desktop.open', requestId: 'desktop-link', params: { permissions: ['view'] } }))
            .rejects.toThrow('Remote desktop is not available over this link yet; use the existing relay connection.');
        const listed = await link.request('client.hello', { type: 'client.hello', clientId: 'link-phone' }) as { type: string; sessions: { id: string }[] };
        expect(listed.type).toBe('session.list');
        expect(listed.sessions.map((session) => session.id)).toContain(sessionId);
        await until(() => (events.some((event) => (event as { sessionId?: string }).sessionId === sessionId) ? true : undefined), 'session events reach the link');

        // The relay transport the installed app uses still answers beside it.
        const client = new MuxrClient({
            mode: 'hosted',
            relayUrl: stored.relayUrl,
            machineId: stored.machineId,
            token: stored.credential,
            hostedGrant: stored,
            requestTimeoutMs: 5_000,
        });
        client.connect();
        await until(() => (client.state === 'open' ? true : undefined), 'relay transport still opens');
        expect((await client.request('session.list', {})).map((session) => session.id)).toContain(sessionId);

        const otherEvents: unknown[] = [];
        const otherLink = new DeviceLink(linkGrantFrom(other), {
            WebSocket: WebSocket as never,
            onEvent: (event) => otherEvents.push(event),
        });
        await until(() => (otherLink.status === 'online' ? true : undefined), 'other phone comes online');

        const revoking = launch([join(repoRoot, 'scripts/cli.mjs'), 'devices', 'revoke', '1']);
        await until(() => {
            const state = JSON.parse(readFileSync(join(home, 'selfhost.json'), 'utf8')) as {
                machine: { crypto: { pendingRotation?: { revokedDeviceId: string } } };
            };
            return state.machine.crypto.pendingRotation?.revokedDeviceId === stored.deviceId ? true : undefined;
        }, 'revocation recorded');
        expect(answered).toBeDefined();
        // With the state watch event-driven, the revocation can already have
        // ended this link by now; the replay injection then has no live socket
        // to ride, and the two refusals below are the revoked phone's lot.
        const replayWire = (link as unknown as { conn: { send: (message: unknown) => void } | null }).conn;
        if (replayWire !== null) {
            replayWire.send = (message) => {
                const request = message as { t?: string; op?: string; key?: string; session?: string; ack?: number };
                if (request.t === 'req' && request.op === 'client.hello') Object.assign(request, answered);
                send(message);
            };
        }
        await expect(link.request('client.hello', { type: 'client.hello', clientId: 'link-phone' })).rejects.toThrow();
        await expect(link.request('session.list', { type: 'session.list', requestId: 'revoked', params: {} })).rejects.toThrow();
        const next = await otherLink.request('session.start', { type: 'session.start', requestId: 'other', params: { cwd: home } }) as {
            type: string; ok: boolean; data?: { info?: { id?: string } };
        };
        expect(next).toMatchObject({ type: 'result', ok: true });
        const nextId = next.data?.info?.id;
        await until(() => otherEvents.some((event) => (event as { sessionId?: string }).sessionId === nextId) ? true : undefined, 'next broadcast reaches trusted phone');
        expect(events.some((event) => (event as { sessionId?: string }).sessionId === nextId)).toBe(false);
        expect(await until(() => revoking.exitCode === null ? undefined : revoking.exitCode, 'revocation completes'), revoking.output()).toBe(0);
        await until(() => (link.status === 'removed' ? true : undefined), 'revoked phone is removed from the link', 30_000);
        await until(() => (client.state === 'stale' ? true : undefined), 'revoked phone loses the relay transport', 60_000);
        expect(statuses).not.toContain('refused');
        client.close();
        link.stop();
        otherLink.stop();
    }, 180_000);

    it('admits the first link dial right after pairing and moves a live session to a new role without removing it', async () => {
        vi.stubGlobal('WebSocket', WebSocket);
        await stopMachine();
        await startMachine();
        phone.secure.clear();
        vi.resetModules();
        const { claimHostedPairing: claimFresh } = await import('../../../apps/mobile/sources/pairing/application/hostedE2ee.js');
        const release = join(home, 'release-pair');
        const pause = `const { existsSync } = await import('node:fs'); const fetch = globalThis.fetch; globalThis.fetch = async (...args) => { const response = await fetch(...args); if (String(args[0]).endsWith('/grant') && response.ok) while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 20)); return response; };`;
        const pair = launch([join(repoRoot, 'scripts/cli.mjs'), 'pair'], { NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(pause)}` });
        const text = await until(() => /Pairing string \(expires in two minutes\):\s*(\S+)/.exec(pair.output())?.[1], 'pair string');
        const stored = await claimFresh(text);

        // The race: the first dial starts the moment pairing lands. The host
        // must have enrolled the device from its own records by then, and the
        // phone must never see `removed` - whose words are "This device was
        // removed on your computer." - for a pre-admission moment.
        const statuses: LinkStatus[] = [];
        const link = new DeviceLink(linkGrantFrom(stored), { WebSocket: WebSocket as never, onStatus: (status) => statuses.push(status) });
        await until(() => (link.status === 'offline' || link.status === 'removed' ? true : undefined), 'first link dial settles while grant publication is pending', 30_000);
        expect(statuses).not.toContain('removed');
        writeFileSync(release, 'go');
        await until(() => (link.status === 'online' ? true : undefined), 'first link dial comes online right after pairing', 30_000);
        await until(() => (pair.exitCode === null ? undefined : pair.exitCode), 'pair finishes');
        expect(pair.exitCode, pair.output()).toBe(0);
        const started = await link.request('session.start', { type: 'session.start', requestId: 'fresh', params: { cwd: home } }) as {
            type: string; ok?: boolean;
        };
        expect(started).toMatchObject({ ok: true });

        // A role change moves the live session to the new role instead of
        // ending it: the same stored pairing stays online, reads keep working,
        // and a write is refused in the device's own words. It must never be
        // told it was removed.
        setAuthority(stored.deviceId, 'observe');
        await until(async () => {
            try {
                await link.request('session.start', { type: 'session.start', requestId: 'as-view', params: { cwd: home } });
                return undefined; // still admitted as control; the grant has not moved yet
            } catch (error) {
                return error instanceof Error && error.message === 'This device can watch but not make changes.' ? error.message : undefined;
            }
        }, 'a write is refused as view-only, in exactly those words', 30_000);
        expect(await link.request('client.hello', { type: 'client.hello', clientId: 'link-phone' })).toMatchObject({ type: 'session.list' });
        expect(link.status).toBe('online');
        expect(statuses).not.toContain('removed');

        // Moving the role back takes the same live session with it, no
        // re-pairing, still never removed.
        setAuthority(stored.deviceId, 'control');
        await until(async () => {
            try {
                const again = await link.request('session.start', { type: 'session.start', requestId: 'as-control', params: { cwd: home } }) as { ok?: boolean };
                return again.ok === true ? true : undefined;
            } catch { return undefined; }
        }, 'the same session writes again as control', 30_000);
        expect(link.status).toBe('online');
        expect(statuses).not.toContain('removed');
        link.stop();
    }, 120_000);

    it('keeps the host alive and retrying while its relay is down, then back online when it returns', async () => {
        await stopMachine();
        await startMachine();
        const running = host!;
        const statusLines = (): string[] => running.output().match(/^link relay: \w+/gm) ?? [];
        await until(() => (statusLines().includes('link relay: online') ? true : undefined), 'host registers with its relay');
        const onlineBefore = statusLines().filter((line) => line === 'link relay: online').length;

        // The relay goes away under a registered host: every reconnect now
        // dials a socket that fails while still connecting.
        await stop(relay);
        await until(() => {
            if (running.exitCode !== null || running.signalCode !== null) throw new Error(`host died while its relay was down:\n${running.output().slice(-1200)}`);
            return statusLines().at(-1) === 'link relay: offline' ? true : undefined;
        }, 'host reports its relay offline');
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        expect(running.exitCode, running.output().slice(-600)).toBeNull();
        expect(running.signalCode).toBeNull();

        const back = launch([join(repoRoot, 'apps/relay/dist/main.js')], {
            MUXR_RELAY_PORT: String(port),
            MUXR_RELAY_HOST: '127.0.0.1',
            MUXR_RELAY_DATA_DIR: join(home, 'relay'),
            MUXR_RELAY_MDNS: '0',
        });
        relay = back;
        expect(await waitForRelay(back)).toBe(port);
        await until(() => (statusLines().filter((line) => line === 'link relay: online').length > onlineBefore ? true : undefined),
            'host reconnects to its relay on its own', 45_000);
        expect(running.exitCode).toBeNull();
    }, 90_000);

    it('keeps the existing relay available when link state is damaged', async () => {
        await stopMachine();
        const stateFile = join(home, 'relay', 'link-relay.json');
        writeFileSync(stateFile, '{broken', { mode: 0o600 });
        const restarted = launch([join(repoRoot, 'apps/relay/dist/main.js')], {
            MUXR_RELAY_PORT: String(port),
            MUXR_RELAY_HOST: '127.0.0.1',
            MUXR_RELAY_DATA_DIR: join(home, 'relay'),
            MUXR_RELAY_MDNS: '0',
        });
        relay = restarted;
        expect(await waitForRelay(restarted)).toBe(port);
        expect((await fetch(`http://127.0.0.1:${port}/relay/v1/hosts`)).status).toBe(404);
        expect(readFileSync(stateFile, 'utf8')).toBe('{broken');
    }, 30_000);
});
