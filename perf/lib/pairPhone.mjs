/**
 * Pair the emulator with the throwaway host, and prove the herd arrived.
 *
 * The code the host mints rotates and the app's first-run prompts queue on top
 * of the herd screen, so one attempt is flaky in a way that says nothing about
 * the build and one retry is allowed. What an attempt is not allowed to do is
 * pass on chrome: `LIVE`, `SPACES` and `Machine` are painted by an app that
 * never reached a host, and a flow that exited nonzero left the phone somewhere
 * nobody chose. A pass needs the flow's own zero, connected chrome, and one
 * label this run's world actually published.
 */
import { runCommand as run, assertCommandActive } from './commands.mjs';
import { dismissPrompts, dumpUiXml } from './androidSignals.mjs';

/** Connected chrome only: reconnecting or disconnected is not a ready herd. */
export function herdChromeConnected(dump) {
    if (/text="(disconnected|connecting)"/.test(dump)) return false;
    if (/Reconnecting/.test(dump)) return false;
    return /text="connected"/.test(dump);
}

/** The labels this run's herd published, which no unpaired app can paint. */
export function worldLabels(world) {
    const labels = [
        ...(world?.agents ?? []).map((agent) => agent.name),
        ...(world?.panes ?? []).map((pane) => pane.label),
    ];
    return [...new Set(labels.filter((label) => typeof label === 'string' && label.trim() !== ''))];
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shown = (dump, label) => new RegExp(`(text|content-desc)="[^"]*${escape(label)}`).test(dump);

/** Undefined means the herd is really on screen; anything else is the reason. */
export function herdProof(dump, labels) {
    if (!herdChromeConnected(dump)) return 'the herd chrome is not connected';
    if (!labels.some((label) => shown(dump, label))) return 'no pane or agent from this run\'s herd is on screen';
    return undefined;
}

// One file per dump: a failed read is an empty screen, never the last one.
const dumpUi = () => dumpUiXml(40_000, 32 * 1024 * 1024);

/** Poll until the herd is proven on screen, or report why it never was. */
export async function waitForHerd(labels, seconds) {
    const deadline = Date.now() + seconds * 1000;
    let why = 'the herd screen never appeared';
    do {
        why = herdProof(await dumpUi(), labels);
        if (why === undefined) return { ok: true };
        await new Promise((resolve) => setTimeout(resolve, 3000));
    } while (Date.now() < deadline);
    return { ok: false, why };
}

/** A pairing string is a credential; it must not survive into the report. */
const redact = (text, code) => (code === undefined ? text : text.split(code).join('<pairing string>'))
    .replace(/wss?:\/\/\S*pair=\S*/gi, '<pairing string>');

/**
 * @param {{ stack: { mintPairing: Function, world: object }, maestro: Function,
 *   flow?: string, attempts?: number, patienceSeconds?: number }} options
 */
export async function pairPhone({ stack, maestro, flow = 'pair.yaml', attempts = 2, patienceSeconds = 180 }) {
    const labels = worldLabels(stack.world);
    if (labels.length === 0) return { ok: false, why: 'the herd published no pane or agent label to prove pairing with' };
    // A retry is still the same wait from the user's side, so the number the
    // gate judges is measured from the first attempt, not the one that worked.
    const started = Date.now();
    let last = '';
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        assertCommandActive();
        // A dozing or locked emulator reports an empty screen, which reads as a
        // broken app; wake it and keep it awake before anything is asserted.
        for (const args of [
            ['shell', 'svc', 'power', 'stayon', 'true'],
            ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'],
            ['shell', 'wm', 'dismiss-keyguard'],
        ]) await run('adb', args, { timeout: 30_000 }).catch(() => undefined);
        const pairing = await stack.mintPairing();
        if (pairing.code === undefined) {
            pairing.release();
            last = 'the host minted no pairing string';
            continue;
        }
        const flowRun = await maestro(flow, { PAIR_CODE: pairing.code });
        pairing.release();
        const tail = redact(flowRun.output.trim().split('\n').slice(-2).join(' | '), pairing.code);
        if (flowRun.code !== 0) {
            last = `the pairing flow exited ${flowRun.code}: ${tail}`;
            continue;
        }
        // The flow's own wait is short on purpose; a big herd is slow, not
        // broken, so keep watching after the flow gives up.
        const proof = await waitForHerd(labels, patienceSeconds);
        if (proof.ok) {
            await dismissPrompts();
            return { ok: true, attempt, herdVisibleMs: Date.now() - started };
        }
        last = `${proof.why}: ${tail}`;
    }
    return { ok: false, why: `the herd never reached the phone: ${last}` };
}
