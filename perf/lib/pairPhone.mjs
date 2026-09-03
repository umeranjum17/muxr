/**
 * Pair the emulator with the throwaway host, and prove the herd arrived.
 *
 * The code the host mints rotates, the app's first-run prompts queue on top of
 * the herd screen, and the first connect has to fetch the whole herd before
 * anything is visible. All three make a single attempt flaky in a way that says
 * nothing about the build, so one retry is allowed - and the time the herd took
 * to reach the screen is returned, because on a big herd that is the number
 * that matters.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dismissPrompts } from './androidSignals.mjs';

const run = promisify(execFile);

async function herdOnScreen() {
    await run('adb', ['shell', 'uiautomator', 'dump', '/sdcard/pair-check.xml'], { timeout: 40_000 }).catch(() => undefined);
    const dump = await run('adb', ['shell', 'cat', '/sdcard/pair-check.xml'], { timeout: 40_000, maxBuffer: 32 * 1024 * 1024 })
        .then((result) => result.stdout)
        .catch(() => '');
    return /text="(LIVE|SPACES|Machine)"/.test(dump);
}

/** Poll for the herd screen. Undefined means it never arrived. */
export async function waitForHerd(seconds) {
    const started = Date.now();
    const deadline = started + seconds * 1000;
    while (Date.now() < deadline) {
        if (await herdOnScreen()) return Date.now() - started;
        await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    return undefined;
}

/**
 * @param {{ stack: { mintPairing: Function }, maestro: Function, flow: string,
 *   attempts?: number, patienceSeconds?: number }} options
 */
export async function pairPhone({ stack, maestro, flow = 'pair.yaml', attempts = 2, patienceSeconds = 180 }) {
    let last = '';
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
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
        const started = Date.now();
        const flowRun = await maestro(flow, { PAIR_CODE: pairing.code });
        pairing.release();
        // The flow's own wait is short on purpose; a big herd is slow, not
        // broken, so keep watching after the flow gives up.
        const herdVisibleMs = flowRun.code === 0 ? Date.now() - started : await waitForHerd(patienceSeconds);
        if (herdVisibleMs !== undefined) {
            await dismissPrompts();
            return { ok: true, attempt, herdVisibleMs };
        }
        last = flowRun.output.trim().split('\n').slice(-2).join(' | ');
    }
    return { ok: false, why: `the herd never reached the phone: ${last}` };
}
