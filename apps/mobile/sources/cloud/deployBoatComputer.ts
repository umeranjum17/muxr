import { boat, machine, MachineError, setup, words, type HostRecipe, type MachineRef, type MachineStore, type Price, type Provider, type TailnetStep } from '@byokit/cloud';
import { deleteNativeSecret, getNativeSecret, setNativeSecret } from '@/pairing/secrets';

/** A lab build may point at its own Boat stand-in; every other build talks to Boat. */
export const BOAT_API = process.env.EXPO_PUBLIC_MUXR_BOAT_API || 'https://boat.dev/api/v1';
export const BOAT_KEY = 'muxr.cloud.boat-key.v1';
const MACHINE_KEY = 'muxr.cloud.boat-machine.v1';
const PORT = 8792;
const WORK_DIR = '/home/user/muxr';

export const PRICE = { planFloorPerMonth: 20, asleepPerHour: 0, currency: 'USD', source: 'https://docs.boat.dev/pricing', checked: '2026-10-19' } as const;
export const BOAT_PRICES: Price[] = [
    { ...PRICE, size: 'small', perHour: 0.018, basis: '2 vCPU, 4 GB: half the default rate, billed per second while on' },
    { ...PRICE, size: 'default', perHour: 0.036, basis: '4 vCPU, 8 GB: $20 a month buys 2,000,000 VM-seconds, billed per second while on' },
];
export type BoatSize = 'small' | 'default';

/**
 * The published @trymuxr/cli every new Boat computer installs, as the registry tarball checked against its sha256 before install.
 * Bumped with the root package.json version once that version is on npm: the hash needs the published file (`npm view @trymuxr/cli@<v> dist.tarball`, then sha256sum it).
 */
const CLI_TARBALL_URL = 'https://registry.npmjs.org/@trymuxr/cli/-/cli-0.2.7.tgz';
const CLI_TARBALL_SHA256 = 'ffa4b47f8028ff9c842e58b31b161624b223e7117e4e81f214b56c2cadcfe786';
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

export type DeployStep =
    | { step: 'creating' | 'starting' | 'installing' | 'securing' | 'configuring' | 'pairing' }
    | { step: 'sign-in'; url: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const loadRecord = async () => JSON.parse((await getNativeSecret(MACHINE_KEY)) ?? 'null');

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
 * Create a Boat machine (once), put the muxr host on it, join it to the person's tailnet and
 * pair this phone through `muxr pair --handoff`; `pair` runs the phone side with the offer.
 */
export async function deployBoatComputer(o: {
    size: BoatSize;
    onStep: (step: DeployStep) => void;
    pair: (offer: string, deliverWords: (words: string) => void) => Promise<void>;
}): Promise<void> {
    const provider = boat({
        baseUrl: BOAT_API, label: 'Boat', prices: BOAT_PRICES,
        key: async () => {
            const key = await getNativeSecret(BOAT_KEY);
            if (!key) throw new Error('Connect your Boat account first.');
            return key;
        },
    });
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
        await sleep(3_000);
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
        address: {
            hostname: 'muxr-cloud', port: PORT,
            onStep: (s: TailnetStep) => { if (s.step === 'open-page') o.onStep({ step: 'sign-in', url: s.url }); },
        },
        pair: async (_ref, { urls }) => {
            try {
                o.onStep({ step: 'configuring' });
                const configured = await m.run(RECIPE, [...MUXR, 'self-host', '--configure-only', '--loopback', '--install-herdr', '--advertise', urls[0], '--port', String(PORT)], { timeoutMs: 600_000 });
                if (configured.code !== 0) throw new Error(`muxr could not set itself up there: ${configured.stderr.trim().slice(-300)}`);
                o.onStep({ step: 'pairing' });
                // The unit restarts into the configured host within seconds; handoff fails until it is up.
                // ponytail: one long exec holds the handoff open; a provider that caps exec time needs a detached start.
                for (let attempt = 0; attempt < 12; attempt += 1) {
                    let handoff: Awaited<ReturnType<typeof m.handoff>>;
                    try {
                        handoff = await m.handoff(RECIPE, [...MUXR, 'pair', '--handoff'], { prefix: 'muxr-pair-', timeoutMs: 180_000 });
                    } catch (cause) {
                        detail = cause instanceof Error ? cause.message : String(cause);
                        await sleep(5_000);
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
                        await sleep(5_000);
                        continue;
                    }
                    const { wordsFile } = offer;
                    let delivery: Promise<unknown> | undefined;
                    try {
                        await o.pair(offer.offer, (w) => {
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
                    return;
                }
                throw new Error(`muxr did not start on your Boat computer: ${detail}`);
            } catch (cause) {
                detail = cause instanceof Error ? cause.message : String(cause);
                throw cause;
            }
        },
    })) {
        // setup() names each step when it starts work (inspecting → install) or when it is done (installing).
        if (step.step === 'inspecting') o.onStep({ step: 'installing' });
        if (step.step === 'installing') o.onStep({ step: 'securing' });
        if (step.step === 'failed') throw new Error(step.at === 'pairing' && detail ? detail : words(step.cause, { app: 'muxr', label: 'Boat' }));
    }
}
