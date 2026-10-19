import { boat, machine, setup, words, type HostRecipe, type MachineRef, type MachineStore, type Price, type TailnetStep } from '@byokit/cloud';
import { deleteNativeSecret, getNativeSecret, setNativeSecret } from '@/pairing/secrets';

export const BOAT_API = 'https://boat.dev/api/v1';
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
    install: [['npm', 'install', '--global', '--prefix', `${WORK_DIR}/npm`, '--ignore-scripts', '@trymuxr/cli@latest']],
    run: { argv: ['node', `${WORK_DIR}/npm/bin/muxr`, 'up'], env: { MUXR_MODE: 'selfhost' } },
    workDir: WORK_DIR,
};
// `muxr <args>` in the work dir with the kit's node first on PATH, as the unit runs it.
const MUXR = 'n=$(ls -d "$HOME"/.local/share/byokit/node/*/bin 2>/dev/null | tail -n1); PATH="${n:+$n:}$PATH"; cd "$0" && exec node npm/bin/muxr "$@"';
const NEWEST_OFFER = 'f=$(ls -t "$0"/.byokit/outbox/muxr-pair-*.json 2>/dev/null | head -n1); [ -z "$f" ] || cat "$f"';

const store: MachineStore = {
    load: async () => JSON.parse((await getNativeSecret(MACHINE_KEY)) ?? 'null'),
    save: (record) => setNativeSecret(MACHINE_KEY, JSON.stringify(record)),
};

export type DeployStep =
    | { step: 'creating' | 'starting' | 'installing' | 'securing' | 'configuring' | 'pairing' }
    | { step: 'sign-in'; url: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const m = machine({ provider, store });
    // A retry after a later step failed reuses the machine this phone already created.
    let ref: MachineRef | null = (await store.load())?.ref ?? null;
    if (ref === null) {
        o.onStep({ step: 'creating' });
        ref = await m.create({ name: RECIPE.name, size: o.size, keepCopies: false });
    }
    const created = ref;
    o.onStep({ step: 'starting' });
    for (let state = await m.state(); state !== 'on'; state = await m.state()) {
        if (state === 'asleep') await m.wake();
        else if (state === 'failed' || state === 'gone') {
            await deleteNativeSecret(MACHINE_KEY);
            throw new Error(`Your Boat computer is ${state}. Try again.`);
        }
        await sleep(3_000);
    }

    const id = created.id;
    let detail: string | undefined;
    const exec = (argv: string[], timeoutMs: number) => provider.exec(created, ['sh', '-c', ...argv], { timeoutMs });
    for await (const step of setup({
        provider, store, recipe: RECIPE, confirmId: id,
        pick: (listed) => {
            const found = listed.find((r) => r.id === id);
            if (!found) throw new Error('Your new Boat computer is missing from your account. Try again.');
            return found;
        },
        address: {
            hostname: 'muxr-cloud', port: PORT,
            onStep: (s: TailnetStep) => { if (s.step === 'open-page') o.onStep({ step: 'sign-in', url: s.url }); },
        },
        pair: async (_ref, { urls }) => {
            try {
                o.onStep({ step: 'configuring' });
                const configured = await exec([MUXR, WORK_DIR, 'self-host', '--configure-only', '--loopback', '--install-herdr', '--advertise', urls[0], '--port', String(PORT)], 600_000);
                if (configured.code !== 0) throw new Error(`muxr could not set itself up there: ${configured.stderr.trim().slice(-300)}`);
                o.onStep({ step: 'pairing' });
                // The unit restarts into the configured host within seconds; handoff fails until it is up.
                // ponytail: one long exec holds the handoff open; a provider that caps exec time needs a detached start.
                for (let attempt = 0; attempt < 12; attempt += 1) {
                    // An offer left by an interrupted earlier handoff must never be read as this one.
                    await exec(['rm -f "$0"/.byokit/outbox/muxr-pair-*.json', WORK_DIR], 30_000);
                    let settled = false;
                    const handoff = exec([MUXR, WORK_DIR, 'pair', '--handoff'], 180_000)
                        .catch((cause) => ({ code: 1, stdout: '', stderr: String(cause), timedOut: false }))
                        .finally(() => { settled = true; });
                    let offer: Offer | undefined;
                    while (!settled && offer === undefined) {
                        await sleep(2_000);
                        offer = parseOffer((await exec([NEWEST_OFFER, WORK_DIR], 30_000)).stdout);
                    }
                    if (offer === undefined) {
                        detail = (await handoff).stderr.trim().slice(-300);
                        await sleep(5_000);
                        continue;
                    }
                    const { wordsFile } = offer;
                    const deliveries: Promise<unknown>[] = [];
                    await o.pair(offer.offer, (w) => { deliveries.push(m.deliver(RECIPE, wordsFile, new TextEncoder().encode(w))); });
                    const result = await handoff;
                    await Promise.all(deliveries);
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
