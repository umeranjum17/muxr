/**
 * A machine that does not own its relay joins the byokit link through the
 * owner's enrolment (step 5): it dials out, so it needs no open port.
 *
 * One flow against the real relay and host: the relay owner mints both
 * enrolments; the machine joins with `muxr connect` and runs without the owner
 * secret, and `muxr pair` asks
 * that running machine to offer the QR over its owner-only local socket.
 * The paired phone dials the link; after a restart the spent enrolment token
 * is ignored because the host key is enough.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostId, unb64url } from '@byokit/pair';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cliMain, hostMain, hostRoot, relayMain, waitForRelay } from './host.js';
import { linkPair, machineIdentity, readSelfhostState } from './hostSetup.js';

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

import { pairOverLink, type StoredHostedGrant } from '../../apps/mobile/sources/pairing/application/linkPairing.js';
import { LinkFirstClient } from '../../apps/mobile/sources/pairing/infrastructure/linkFirstClient.js';

// The machine's own HOME, so `muxr connect` writes its service definition there
// (service commands stay off) and never near the desk's muxr.service.
const root = mkdtempSync(join(tmpdir(), 'muxr-link-shared-relay-'));
const home = join(root, '.muxr');
mkdirSync(home, { mode: 0o700 });
process.env.MUXR_HOME = home;
const children = new Set<ChildProcess>();

function launch(args: string[], extra: NodeJS.ProcessEnv = {}): ChildProcess & { output: () => string } {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, MUXR_HOME: home, MUXR_NO_SERVICE_COMMANDS: '1', ...extra };
    for (const key of ['RELAY_TOKEN', 'RELAY_URL', 'MACHINE_ID', 'RELAY_AUTH', 'DATA_DIR']) delete env[`MUXR_${key}`];
    if (extra.MUXR_RELAY_PORT === undefined) delete env.MUXR_RELAY_PORT;
    if (extra.MUXR_MODE === undefined) delete env.MUXR_MODE;
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
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await exited;
}

async function until<T>(produce: () => T | undefined | Promise<T | undefined>, what: string, timeoutMs = 30_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await produce();
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

const json = async (base: string, path: string, options: Parameters<typeof fetch>[1] = {}) => {
    const response = await fetch(`${base}${path}`, { ...options, headers: { 'content-type': 'application/json', ...options.headers } });
    return { response, body: await response.json() as Record<string, unknown> };
};

let port = 0;
let base = '';
let mint = '';
let identity: ReturnType<typeof machineIdentity> | undefined;
let relay: ChildProcess | undefined;
let host: (ChildProcess & { output: () => string }) | undefined;

async function startRelay(): Promise<void> {
    relay = launch([relayMain], {
        MUXR_RELAY_PORT: '0',
        MUXR_RELAY_HOST: '127.0.0.1',
        MUXR_RELAY_DATA_DIR: join(home, 'relay'),
        MUXR_RELAY_MDNS: '0',
    });
    port = await waitForRelay(relay);
    base = `http://127.0.0.1:${port}`;
    mint = JSON.parse(readFileSync(join(home, 'relay', 'mint-secret'), 'utf8')) as string;
}

function startMachine(): void {
    host = launch([hostMain, '--fake'], { MUXR_MODE: 'selfhost' });
}

describe('a shared-relay machine joins the link through the owner enrolment', () => {
    const relayUrl = () => `ws://127.0.0.1:${port}`;

    beforeAll(async () => {
        await startRelay();
        // The relay owner mints both enrolments; one string carries both claims.
        // A loopback relay may be a plain ws:// address.
        const opened = await json(base, '/v1/selfhost/enrollments', {
            method: 'POST', headers: { authorization: `Bearer ${mint}` }, body: JSON.stringify({ relay_url: relayUrl() }),
        });
        expect(opened.response.status, JSON.stringify(opened.body)).toBe(201);
        const linkEnrolment = await json(base, '/relay/v1/enrolments', {
            method: 'POST', headers: { authorization: `Bearer ${mint}` },
        });
        expect(linkEnrolment.response.status).toBe(201);
        const enrollment = `muxr://enroll?payload=${Buffer.from(JSON.stringify({ v: 1, id: opened.body.enrollment_id,
            claim: opened.body.claim, relay: opened.body.relay_url, expires: Date.now() + 300_000, link: linkEnrolment.body.token })).toString('base64url')}`;

        // The machine joins with `muxr connect`, as setup's relay route does. No
        // service manager runs here, so the host starts once the state lands.
        const connect = launch([cliMain, 'connect', '--enrollment', enrollment, '--no-pair']);
        const joined = new Promise<number | null>((resolve) => connect.once('exit', resolve));
        await until(() => (existsSync(join(home, 'selfhost.json')) || connect.exitCode !== null ? true : undefined), 'connect writes the machine state');
        startMachine();
        expect(await joined, connect.output()).toBe(0);
        const state = readSelfhostState();
        expect(state).toMatchObject({ relayLocation: 'remote', relayUrl: relayUrl(), connectionMode: 'remote' });
        expect(state.mintSecret).toBeUndefined();
        identity = state.machine;
    }, 90_000);

    afterAll(async () => {
        await Promise.all([...children].map((child) => stop(child)));
        rmSync(root, { recursive: true, force: true });
    });

    it('registers the host by its proof, carries the paired phone over the link, and survives a restart on the used token', async () => {
        await until(() => (host!.output().includes('link relay: online') ? true : undefined),
            `host link registers on the shared relay; host said: ${JSON.stringify(host!.output().slice(-400))}`);
        const hostAddress = hostId(unb64url(Buffer.from(identity!.crypto.boxPublicKey, 'base64').toString('base64url')));
        const hosts = await json(base, '/relay/v1/hosts', { headers: { authorization: `Bearer ${mint}` } });
        const listed = Array.isArray(hosts.body) ? hosts.body as Array<{ id?: string }>
            : Array.isArray(hosts.body.hosts) ? hosts.body.hosts as Array<{ id?: string }> : [];
        expect(listed.some((entry) => entry.id === hostAddress), JSON.stringify({ body: hosts.body, hostAddress })).toBe(true);

        await until(() => (existsSync(join(home, 'host', 'pair.sock')) ? true : undefined), 'machine pairing socket');
        let output = '';
        const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output += String(chunk); return true; });
        const pairing = linkPair(readSelfhostState(), { approve: () => true }).finally(() => spy.mockRestore());
        const text = await until(() => /byokit-link:1:[A-Za-z0-9_-]+/.exec(output)?.[0], 'machine link offer');
        const stored = await pairOverLink(text) as StoredHostedGrant;
        await pairing;

        const client = new LinkFirstClient({
            hostedGrant: stored,
            requestTimeoutMs: 5_000,
        });
        client.connect();
        await until(() => (client.state === 'open' ? true : undefined), 'relay session opens on the shared relay');
        await client.request('herdr.tree', {});
        await until(() => (client.state === 'open' && client.transport === 'link' ? true : undefined), 'session comes online over the shared relay link', 40_000);
        expect((await client.request('machines.list', {})).length).toBeGreaterThan(0);

        // A restart re-registers with the spent token; the key alone is enough.
        await stop(host);
        host = undefined;
        // No host will reopen this socket; assert the same error at once.
        process.env.MUXR_PAIR_SOCKET_WAIT_MS = '0';
        try {
            await expect(linkPair(readSelfhostState())).rejects.toThrow('Start muxr on this computer with `muxr daemon start`, then run `muxr pair` again.');
        } finally {
            delete process.env.MUXR_PAIR_SOCKET_WAIT_MS;
        }
        startMachine();
        await until(() => (host!.output().includes('link relay: online') ? true : undefined), 'restarted host re-registers on the spent token');
        client.close();
        const again = new LinkFirstClient({
            hostedGrant: stored,
            requestTimeoutMs: 5_000,
        });
        again.connect();
        await until(() => (again.state === 'open' ? true : undefined), 'relay session reopens after the restart');
        await again.request('herdr.tree', {});
        await until(() => (again.state === 'open' && again.transport === 'link' ? true : undefined), 'session returns over the link after the restart', 40_000);
        const credential = readSelfhostState()?.machineCredential;
        const status = await json(base, '/v1/selfhost/machine-status', { headers: { authorization: `Bearer ${credential}` } });
        expect(status.body.online).toBe(true);
        const revoked = await json(base, '/v1/selfhost/machine-status', {
            method: 'DELETE', headers: { authorization: `Bearer ${credential}` },
        });
        expect(revoked.response.status).toBe(200);
        await until(async () => {
            const hosts = await json(base, '/relay/v1/hosts', { headers: { authorization: `Bearer ${mint}` } });
            const listed = Array.isArray(hosts.body) ? hosts.body as Array<{ id?: string }>
                : Array.isArray(hosts.body.hosts) ? hosts.body.hosts as Array<{ id?: string }> : [];
            return listed.some((entry) => entry.id === hostAddress) ? undefined : true;
        }, 'revoked host disappears from the link');
        again.close();
        client.close();
    }, 120_000);
});
