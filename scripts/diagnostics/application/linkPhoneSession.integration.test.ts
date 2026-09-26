/**
 * The phone's session channel moves onto the byokit link with the keys it
 * already stores (step 2), falling back to the relay transport.
 *
 * One flow against the real relay, self-host host and `muxr pair`: a phone
 * paired before a host restart reaches its machine over the link with no
 * re-pairing; when the link route is gone (what a relay without link state
 * serves) the same session client ends up on the relay transport instead; and
 * a phone without matching enrollment evidence stays on the relay transport.
 *
 * The relay is spawned on MUXR_RELAY_PORT=0 and its port read from
 * waitForRelay; each restart records its newly bound port in selfhost.json.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { waitForRelay } from './waitForRelay.mjs';
import { machineIdentity } from '../../setup/index.mjs';

const phone = { secure: new Map<string, string>(), local: new Map<string, string>() };

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
import { LinkFirstClient } from '../../../apps/mobile/sources/pairing/infrastructure/linkFirstClient.js';

const repoRoot = join(import.meta.dirname, '../../..');
const home = mkdtempSync(join(tmpdir(), 'muxr-link-phone-'));
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
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
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

/** `linkState`: what the relay's link state file looks like when it starts. */
async function startMachine(linkState: 'fresh' | 'damaged'): Promise<void> {
    const stateFile = join(home, 'relay', 'link-relay.json');
    if (linkState === 'damaged') writeFileSync(stateFile, '{broken', { mode: 0o600 });
    else rmSync(stateFile, { force: true });
    const started = launch([join(repoRoot, 'apps/relay/dist/main.js')], {
        MUXR_RELAY_PORT: '0',
        MUXR_RELAY_HOST: '127.0.0.1',
        MUXR_RELAY_DATA_DIR: join(home, 'relay'),
        MUXR_RELAY_MDNS: '0',
    });
    relay = started;
    port = await waitForRelay(started);
    const previous = (() => {
        try { return JSON.parse(readFileSync(join(home, 'selfhost.json'), 'utf8')); }
        catch { return undefined; }
    })();
    writeFileSync(join(home, 'selfhost.json'), `${JSON.stringify({
            ...previous,
            version: 1,
            machine: previous?.machine ?? { ...machineIdentity(undefined), name: 'Desk' },
            relayPort: port,
            relayUrl: `ws://127.0.0.1:${port}`,
            relayLocation: 'local',
            relayRole: 'single-machine',
            connectionMode: 'lan',
            webEnabled: false,
            mintSecret: JSON.parse(readFileSync(join(home, 'relay', 'mint-secret'), 'utf8')),
        }, null, 2)}\n`, { mode: 0o600 });
    host = launch([join(repoRoot, 'apps/host/dist/main.js'), '--fake'], { MUXR_MODE: 'selfhost' });
    const running = host;
    await until(() => (running.output().includes('host -> ') ? true : undefined), 'host start');
}

async function stopMachine(): Promise<void> {
    await stop(host);
    await stop(relay);
}

function sessionClient(stored: StoredHostedGrant): LinkFirstClient {
    return new LinkFirstClient({
        mode: 'hosted',
        relayUrl: stored.relayUrl,
        machineId: stored.machineId,
        token: stored.credential,
        hostedGrant: stored,
        requestTimeoutMs: 5_000,
    });
}

describe('the phone session channel on the byokit link', () => {
    let stored: StoredHostedGrant;
    const linkDials: string[] = [];
    const linkSockets: WebSocket[] = [];
    const relaySockets: WebSocket[] = [];
    let failRelay = false;

    beforeAll(async () => {
        class TrackedWebSocket extends WebSocket {
            constructor(url: string | URL, protocols?: string | string[]) {
                super(url, protocols);
                if (new URL(String(url)).pathname.startsWith('/link/v1/')) {
                    linkDials.push(String(url));
                    linkSockets.push(this);
                } else {
                    relaySockets.push(this);
                    if (failRelay) queueMicrotask(() => this.terminate());
                }
            }
        }
        vi.stubGlobal('WebSocket', TrackedWebSocket);
        await startMachine('fresh');
        const pair = launch([join(repoRoot, 'scripts/cli.mjs'), 'pair']);
        const text = await until(() => /Pairing string \(expires in two minutes\):\s*(\S+)/.exec(pair.output())?.[1], 'muxr pair string');
        stored = await claimHostedPairing(text);
        await until(() => (pair.exitCode === null ? undefined : pair.exitCode), 'muxr pair finishes');
        expect(pair.exitCode, pair.output()).toBe(0);
        await stopMachine();
    }, 90_000);

    afterEach(async () => { failRelay = false; await stopMachine(); });
    afterAll(async () => {
        vi.unstubAllGlobals();
        await Promise.all([...children].map((child) => stop(child)));
        rmSync(home, { recursive: true, force: true });
    });

    it('dials the link with stored keys after enrollment is announced', async () => {
        await startMachine('fresh');
        stored.relayUrl = `ws://127.0.0.1:${port}`;
        const eventSessions: string[] = [];
        const overLink = sessionClient(stored);
        overLink.onEvent((sessionId) => eventSessions.push(sessionId));
        overLink.connect();
        await until(() => (overLink.state === 'open' ? true : undefined), 'relay session opens', 30_000);
        // The real phone refreshes the tree as soon as its session opens
        // (sync.refreshHerdTree), and the enrolment flag rides that reply when
        // the host's link is already online; the reverse ordering arrives as a
        // later machine.hello, which re-trees through the client itself.
        await overLink.request('herdr.tree', {});
        await until(() => (overLink.state === 'open' && overLink.transport === 'link' ? true : undefined),
            'session comes online over the link', 30_000);
        expect(linkDials.length).toBeGreaterThan(0);
        expect((await overLink.request('machines.list', {})).length).toBeGreaterThan(0);
        const started = await overLink.request('session.start', { cwd: home }) as { info?: { id?: string } };
        const sessionId = started.info?.id;
        expect(typeof sessionId).toBe('string');
        await until(() => (eventSessions.includes(sessionId!) ? true : undefined),
            'session broadcasts reach the link session');

        const transitions: Array<{ state: string; transport: string }> = [];
        overLink.onStateChange((state) => transitions.push({ state, transport: overLink.transport }));
        linkSockets.at(-1)!.terminate();
        await until(() => (transitions.some((entry) => entry.transport === 'relay') ? true : undefined),
            'link hands the session to relay');
        expect(transitions.find((entry) => entry.transport === 'relay')?.state).toBe('open');
        expect((await overLink.request('machines.list', {})).length).toBeGreaterThan(0);
        await until(() => (overLink.transport === 'link' ? true : undefined), 'link recovers', 30_000);

        failRelay = true;
        relaySockets.at(-1)!.terminate();
        linkSockets.at(-1)!.terminate();
        await until(() => (!overLink.isLive() ? true : undefined), 'both transports unavailable');
        const waiting = overLink.request('machines.list', {}, 15_000);
        const waitingDesktop = overLink.request('desktop.capabilities', {}, 30_000);
        await until(() => (overLink.transport === 'link' ? true : undefined), 'link recovers before relay', 30_000);
        expect((await waiting).length).toBeGreaterThan(0);
        expect(await waitingDesktop).toMatchObject({ available: expect.any(Boolean) });
        failRelay = false;
        overLink.close();
    }, 120_000);

    it('keeps an enrolled phone on the relay without a link enrollment flag', async () => {
        await startMachine('damaged');
        expect((await fetch(`http://127.0.0.1:${port}/relay/v1/hosts`)).status).toBe(404);
        stored.relayUrl = `ws://127.0.0.1:${port}`;
        const dialsBefore = linkDials.length;
        const overRelay = sessionClient(stored);
        overRelay.connect();
        await until(() => (overRelay.state === 'open' ? true : undefined), 'relay session opens', 45_000);
        expect((await overRelay.request('herdr.tree', {})).workspaces).toBeDefined();
        expect((await overRelay.request('machines.list', {})).length).toBeGreaterThan(0);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(overRelay.transport).toBe('relay');
        expect(linkDials).toHaveLength(dialsBefore);
        overRelay.close();
    }, 60_000);
});
