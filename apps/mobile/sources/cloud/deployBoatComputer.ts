import { boat, machine, MachineError, setup, words, type HostRecipe, type MachineRef, type MachineStore, type Price, type Provider } from '@byokit/cloud';
import { Platform } from 'react-native';
import { applySshAfterPairing, establishSshTunnel, getCachedConnectionSettings, stopSshTunnel, type SshFieldInput } from '@/connection';
import { generateSshLoginKey, sshFingerprint } from '@/connection/sshPublicKey';
import { deleteNativeSecret, getNativeSecret, setNativeSecret } from '@/pairing/secrets';

/** A lab build may point at its own Boat stand-in; every other build talks to Boat. */
export const BOAT_API = process.env.EXPO_PUBLIC_MUXR_BOAT_API || 'https://boat.dev/api/v1';
export const BOAT_KEY = 'muxr.cloud.boat-key.v1';
const MACHINE_KEY = 'muxr.cloud.boat-machine.v1';
/** The paired machine id of the Boat computer, so the Computer screen knows which computer it can add a screen to. */
const PAIRED_KEY = 'muxr.cloud.boat-paired.v1';
const PORT = 8792;
const WORK_DIR = '/home/user/muxr';
/**
 * The pinned CLI's `--loopback` takes only a `*.ts.net` advertise name. Nothing dials it: the phone reaches the
 * loopback relay through its own SSH tunnel, and keeps the relay's loopback address once paired.
 */
const SSH_ONLY_ADVERTISE = `ws://muxr-cloud.ts.net:${PORT}`;
const RELAY_ON_MACHINE = `ws://127.0.0.1:${PORT}`;

export const PRICE = { planFloorPerMonth: 20, asleepPerHour: 0, currency: 'USD', source: 'https://docs.boat.dev/pricing', checked: '2026-10-19' } as const;
export const BOAT_PRICES: Price[] = [
    { ...PRICE, size: 'small', perHour: 0.018, basis: '2 vCPU, 4 GB: half the default rate, billed per second while on' },
    { ...PRICE, size: 'default', perHour: 0.036, basis: '4 vCPU, 8 GB: $20 a month buys 2,000,000 VM-seconds, billed per second while on' },
];
/** The cheapest size's hourly price: what every entry point quotes as "from". */
export const BOAT_FROM_PER_HOUR = Math.min(...BOAT_PRICES.flatMap((price) => price.perHour ?? []));
export type BoatSize = 'small' | 'default';

/**
 * The published @trymuxr/cli every new Boat computer installs, as the registry tarball checked against its sha256 before install.
 * Bumped with the root package.json version once that version is on npm: the hash needs the published file (`npm view @trymuxr/cli@<v> dist.tarball`, then sha256sum it).
 */
const CLI_TARBALL_URL = 'https://registry.npmjs.org/@trymuxr/cli/-/cli-0.2.9.tgz';
const CLI_TARBALL_SHA256 = 'aeeb5d01bb223e21c67f45ba8fdafc433bd5f051d2d0a7628f4b1545421c32f4';
/** Fetch with the kit's node (22 has fetch), refuse a hash mismatch, then install the file. */
const FETCH_TARBALL = `const c=require('crypto'),f=require('fs');fetch(process.argv[1]).then(r=>{if(!r.ok)throw new Error('download '+r.status);return r.arrayBuffer()}).then(b=>{const h=c.createHash('sha256').update(Buffer.from(b)).digest('hex');if(h!==process.argv[2])throw new Error('sha256 mismatch '+h);f.writeFileSync(process.argv[3],Buffer.from(b))})`;

/** The muxr host as the kit installs it: the published CLI under the work dir, run by `muxr up` in self-host mode. */
const RECIPE: HostRecipe = {
    name: 'muxr',
    node: {
        version: '22.23.3',
        sha256: {
            'linux-x64': 'df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de',
            'linux-arm64': 'a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f',
        },
    },
    install: [
        ['node', '-e', FETCH_TARBALL, CLI_TARBALL_URL, CLI_TARBALL_SHA256, `${WORK_DIR}/cli.tgz`],
        ['npm', 'install', '--global', '--prefix', `${WORK_DIR}/npm`, '--ignore-scripts', `${WORK_DIR}/cli.tgz`],
    ],
    run: { argv: ['node', `${WORK_DIR}/npm/bin/muxr`, 'up'], env: { MUXR_MODE: 'selfhost' } },
    workDir: WORK_DIR,
};
/** The muxr CLI as the recipe's unit runs it; `machine.run` puts the kit's node first on PATH and sets `recipe.run.env`. */
const MUXR = ['node', `${WORK_DIR}/npm/bin/muxr`];

/**
 * The screen for sign-ins, as root: the host's own Xvfb needs `xvfb`, the window session and the engine's libraries
 * (the no-screen card's line), plus Firefox from Mozilla's apt repo, its key checked against its sha256 (fingerprint
 * 35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3), since Ubuntu's own `firefox` is a snap stub. Safe to run again.
 */
const SCREEN_SCRIPT = [
    'set -eu',
    'export DEBIAN_FRONTEND=noninteractive',
    'install -d -m 0755 /etc/apt/keyrings',
    'curl -fsSL https://packages.mozilla.org/apt/repo-signing-key.gpg -o /etc/apt/keyrings/packages.mozilla.org.asc',
    "echo '3ecc63922b7795eb23fdc449ff9396f9114cb3cf186d6f5b53ad4cc3ebfbb11f  /etc/apt/keyrings/packages.mozilla.org.asc' | sha256sum -c --quiet -",
    "echo 'deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main' > /etc/apt/sources.list.d/mozilla.list",
    "printf 'Package: *\\nPin: origin packages.mozilla.org\\nPin-Priority: 1000\\n' > /etc/apt/preferences.d/mozilla",
    // A new machine may still be running its own first apt job: wait for the lock rather than fail on it.
    'apt-get -o DPkg::Lock::Timeout=300 update -q',
    'apt-get -o DPkg::Lock::Timeout=300 install -y -q --no-install-recommends xvfb xfce4 xfce4-terminal dbus-x11 libpipewire-0.3-0t64 libxkbcommon0 libevdev2 firefox',
].join('\n');
export const ADD_SCREEN = ['sh', '-c', SCREEN_SCRIPT] as const;
const SCREEN_TIMEOUT_MS = 900_000;

export type DeployStep = { step: 'creating' | 'starting' | 'installing' | 'configuring' | 'screen' | 'connecting' | 'pairing' };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const loadRecord = async () => JSON.parse((await getNativeSecret(MACHINE_KEY)) ?? 'null');

function boatProvider(): Provider {
    return boat({
        baseUrl: BOAT_API, label: 'Boat', prices: BOAT_PRICES,
        key: async () => {
            const key = await getNativeSecret(BOAT_KEY);
            if (!key) throw new Error('Connect your Boat account first.');
            return key;
        },
    });
}

async function addScreen(provider: Provider, ref: MachineRef): Promise<void> {
    const done = await provider.exec(ref, ADD_SCREEN, { root: true, timeoutMs: SCREEN_TIMEOUT_MS });
    if (done.timedOut) throw new Error('Adding the screen took longer than 15 minutes on your Boat computer. Try again.');
    if (done.code !== 0) throw new Error(`The screen did not install on your Boat machine: ${(done.stderr.trim() || done.stdout.trim()).slice(-300)}`);
}

/** A saved cloud computer suppresses the dock's create offer, including during setup. */
export async function hasBoatComputer(): Promise<boolean> {
    return Platform.OS !== 'web' && Boolean((await loadRecord())?.ref);
}

/** Whether the computer this phone is connected to is the Boat computer it set up. */
export async function isBoatComputer(machineId: string | undefined): Promise<boolean> {
    return machineId !== undefined && machineId !== '' && (await getNativeSecret(PAIRED_KEY)) === machineId;
}

/** Put the screen for sign-ins on this phone's Boat computer, without a redeploy; the host starts it when Computer opens. */
export async function addBoatScreen(): Promise<void> {
    const ref: MachineRef | undefined = (await loadRecord())?.ref;
    if (!ref) throw new Error('This phone no longer knows its Boat computer, so it cannot add a screen. Run the command on it instead.');
    await addScreen(boatProvider(), ref);
}

export async function pendingBoatSize(): Promise<BoatSize | undefined> {
    return (await loadRecord())?.pending?.size;
}

type Offer = { offer: string; wordsFile: string };

function parseOffer(text: string): Offer | undefined {
    try {
        const parsed = JSON.parse(text);
        return typeof parsed?.offer === 'string' && typeof parsed?.wordsFile === 'string' ? parsed : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Boat lets this phone's new login key in and answers with the machine's SSH address and host key. Boat is
 * reached over HTTPS with the person's own key, so its host key is the one the SSH login must find.
 */
async function boatSsh(id: string, publicKey: string): Promise<{ host: string; port: string; user: string; fingerprint: string }> {
    const key = await getNativeSecret(BOAT_KEY);
    if (!key) throw new Error('Connect your Boat account first.');
    let res: Response;
    try {
        res = await fetch(`${BOAT_API}/sandboxes/${encodeURIComponent(id)}/sshkey`, {
            method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: JSON.stringify({ key: publicKey }),
        });
    } catch {
        throw new Error('Could not reach Boat. Check your connection and try again.');
    }
    const ssh = await res.json().catch(() => ({})) as { hostKey?: unknown; sshEndpoint?: unknown; machineIp?: unknown; sshUser?: unknown; error?: unknown };
    if (!res.ok) throw new Error(`Boat did not open SSH to your cloud machine (${res.status}${typeof ssh.error === 'string' ? `: ${ssh.error}` : ''}). Try again.`);
    const endpoint = typeof ssh.sshEndpoint === 'string' ? ssh.sshEndpoint : undefined;
    const at = endpoint?.lastIndexOf(':') ?? -1;
    const host = endpoint !== undefined && at > 0 ? endpoint.slice(0, at) : ssh.machineIp;
    const port = endpoint !== undefined && at > 0 ? endpoint.slice(at + 1) : '22';
    const fingerprint = typeof ssh.hostKey === 'string' ? await sshFingerprint(ssh.hostKey) : undefined;
    if (typeof host !== 'string' || host === '' || fingerprint === undefined) throw new Error('Boat did not say how to reach your cloud machine over SSH. Try again.');
    return { host, port, user: typeof ssh.sshUser === 'string' && ssh.sshUser !== '' ? ssh.sshUser : 'user', fingerprint };
}

/**
 * Create a Boat machine (once), put the muxr host on it, reach it over SSH with a login key this phone makes,
 * and pair this phone through that tunnel with `muxr pair --handoff`; `pair` runs the phone side with the offer.
 * The machine joins no tailnet: Tailscale is for the person's own devices.
 */
export async function deployBoatComputer(o: {
    size: BoatSize;
    /** Add the screen for sign-ins (off unless the person chose it). */
    screen: boolean;
    onStep: (step: DeployStep) => void;
    pair: (offer: string, tunnelPort: number, deliverWords: (words: string) => void) => Promise<void>;
}): Promise<void> {
    const provider = boatProvider();
    // One store per deploy: the kit caches the record it loaded under the store object, so a shared one would keep a cleared machine.
    const store: MachineStore = {
        load: loadRecord,
        save: (record) => setNativeSecret(MACHINE_KEY, JSON.stringify(record)),
    };
    const m = machine({ provider, store });
    // A retry after a later step failed reuses the machine this phone already created.
    let ref: MachineRef | null = (await store.load())?.ref ?? null;
    if (ref === null) {
        o.onStep({ step: 'creating' });
        // The kit saves the create's idempotency key in the store first, so a retry after a lost answer gets the same computer back.
        ref = await m.create({ name: RECIPE.name, size: o.size, keepCopies: false });
    }
    const created = ref;
    o.onStep({ step: 'starting' });
    const startDeadline = Date.now() + 600_000;
    for (let state = await m.state(); state !== 'on'; state = await m.state()) {
        if (state === 'gone') {
            await deleteNativeSecret(MACHINE_KEY);
            throw new Error('Your Boat computer is gone. Try again.');
        }
        if (state === 'failed') {
            await m.remove(created.id);
            await deleteNativeSecret(MACHINE_KEY);
            throw new Error('Your Boat computer failed, so muxr removed it. Try again.');
        }
        if (Date.now() > startDeadline) throw new Error('Boat is still starting your computer. Try again in a few minutes.');
        if (state === 'asleep') await m.wake();
        // Boat reports a new machine on within a few seconds, so a longer poll is mostly dead time.
        await sleep(1_000);
    }

    const id = created.id;
    let detail: string | undefined;
    for await (const step of setup({
        provider, store, recipe: RECIPE, confirmId: id,
        pick: (listed) => {
            const found = listed.find((r) => r.id === id);
            if (!found) throw new MachineError('no-machine', 'Your new Boat computer is missing from your account. Try again.');
            return found;
        },
        pair: async () => {
            let tunnel = false;
            try {
                o.onStep({ step: 'configuring' });
                const configured = await m.run(RECIPE, [...MUXR, 'self-host', '--configure-only', '--loopback', '--install-herdr', '--advertise', SSH_ONLY_ADVERTISE, '--port', String(PORT)], { timeoutMs: 600_000 });
                if (configured.code !== 0) throw new Error(`muxr could not set itself up there: ${configured.stderr.trim().slice(-300)}`);
                if (o.screen) {
                    o.onStep({ step: 'screen' });
                    await addScreen(provider, created);
                }
                o.onStep({ step: 'connecting' });
                const login = generateSshLoginKey('muxr phone');
                const target = await boatSsh(id, login.publicKey);
                const ssh: SshFieldInput = { host: target.host, username: target.user, port: target.port, relayPort: String(PORT), password: '', privateKey: login.privateKey, passphrase: '' };
                let hostKeyMismatch = false;
                const opened = await establishSshTunnel(ssh, async (fingerprint) => {
                    hostKeyMismatch = fingerprint !== target.fingerprint;
                    return !hostKeyMismatch;
                });
                if (hostKeyMismatch) throw new Error('Your cloud machine answered with a different SSH key than Boat gave muxr, so muxr stopped before signing in. Try again.');
                if (!opened.ok) throw new Error(opened.message);
                tunnel = true;
                o.onStep({ step: 'pairing' });
                // The unit restarts into the configured host within seconds; handoff fails until it is up, so retry
                // quickly (40 x 1.5 s keeps the one-minute budget).
                // ponytail: one long exec holds the handoff open; a provider that caps exec time needs a detached start.
                for (let attempt = 0; attempt < 40; attempt += 1) {
                    let handoff: Awaited<ReturnType<typeof m.handoff>>;
                    try {
                        handoff = await m.handoff(RECIPE, [...MUXR, 'pair', '--handoff'], { prefix: 'muxr-pair-', timeoutMs: 180_000 });
                    } catch (cause) {
                        detail = cause instanceof Error ? cause.message : String(cause);
                        await sleep(1_500);
                        continue;
                    }
                    const done = handoff.done.catch((cause) => ({ code: 1, stdout: '', stderr: String(cause), timedOut: false }));
                    let offer: Offer | undefined;
                    try {
                        for await (const read of handoff.offer) {
                            offer = parseOffer(read.text);
                            if (offer !== undefined) break;
                        }
                    } catch (cause) {
                        detail = cause instanceof Error ? cause.message : String(cause);
                    }
                    if (offer === undefined) {
                        detail = (await done).stderr.trim().slice(-300) || detail;
                        await sleep(1_500);
                        continue;
                    }
                    const { wordsFile } = offer;
                    let delivery: Promise<unknown> | undefined;
                    try {
                        await o.pair(offer.offer, opened.localPort, (w) => {
                            delivery = handoff.deliver(wordsFile, new TextEncoder().encode(w));
                            delivery.catch(() => {});
                        });
                    } catch (cause) {
                        await done;
                        throw cause;
                    }
                    const result = await done;
                    await delivery;
                    if (result.code !== 0) throw new Error(`muxr did not finish pairing on your Boat computer: ${result.stderr.trim().slice(-300)}`);
                    // From now on the phone reaches this computer only through SSH, with the key it just made.
                    const applied = await applySshAfterPairing(ssh, { hostKey: opened.hostKey, relayUrl: RELAY_ON_MACHINE });
                    if (!applied.ok) throw new Error(applied.message);
                    const paired = getCachedConnectionSettings().machineId;
                    if (paired) await setNativeSecret(PAIRED_KEY, paired);
                    tunnel = false;
                    return;
                }
                throw new Error(`muxr did not start on your Boat computer: ${detail}`);
            } catch (cause) {
                detail = cause instanceof Error ? cause.message : String(cause);
                throw cause;
            } finally {
                if (tunnel) await stopSshTunnel();
            }
        },
    })) {
        // setup() names each step when it starts work (inspecting → install) or when it is done (installing).
        if (step.step === 'inspecting') o.onStep({ step: 'installing' });
        if (step.step === 'failed') throw new Error(step.at === 'pairing' && detail ? detail : words(step.cause, { app: 'muxr', label: 'Boat' }));
    }
}
