import { randomBytes } from 'node:crypto';
import { constants, chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomicWrite, print } from '../infrastructure/runtime.mjs';
import { readSelfhostState } from '../infrastructure/selfhost.mjs';
import { linkPair } from './linkPair.mjs';

const LIMIT = 64 * 1024;
const WAIT_MS = 120_000;

/** BYOKit deliver atomically writes raw bytes to <workDir>/.byokit/inbox/<file>. */
export async function pairHandoff(state) {
    const devices = readSelfhostState()?.machine?.crypto?.devices;
    if (!Array.isArray(devices)) throw new Error('could not read this computer\'s paired devices; handoff pairing refused');
    if (devices.length > 0) throw new Error('Handoff pairing is only for the first device. Pair more devices from an already paired phone.');
    const root = join(process.cwd(), '.byokit');
    const outbox = join(root, 'outbox');
    const inbox = join(root, 'inbox');
    for (const dir of [root, outbox, inbox]) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const info = lstatSync(dir);
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error('unsafe kit handoff directory');
        chmodSync(dir, 0o700);
    }
    const stem = `muxr-pair-${randomBytes(12).toString('hex')}`;
    const wordsFile = `${stem}.words`;
    const offerPath = join(outbox, `${stem}.json`);
    const wordsPath = join(inbox, wordsFile);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const timer = setTimeout(cancel, WAIT_MS);
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    try {
        return await linkPair(state, {
            signal: controller.signal,
            presentOffer: (offer) => {
                const text = `${JSON.stringify({ version: 1, offer: offer.text, expiresAt: offer.expires, wordsFile })}\n`;
                if (Buffer.byteLength(text) > LIMIT) throw new Error('pairing offer exceeds the 64 KB handoff limit');
                atomicWrite(offerPath, text);
                print('Pairing offer ready in the kit outbox. Waiting for the phone’s two words.');
            },
            approve: async ({ words }) => {
                while (!controller.signal.aborted) {
                    let fd;
                    try {
                        fd = openSync(wordsPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
                    } catch (cause) {
                        if (cause.code !== 'ENOENT') throw cause;
                    }
                    if (fd !== undefined) {
                        try {
                            const info = fstatSync(fd);
                            if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || info.size > LIMIT) {
                                throw new Error('pairing refused: unsafe words file');
                            }
                            if (readFileSync(fd, 'utf8').trim() !== words) throw new Error('pairing refused: the two words did not match');
                            return true;
                        } finally { closeSync(fd); }
                    }
                    await sleep(100, undefined, { signal: controller.signal }).catch(() => {});
                }
                throw new Error('pairing handoff timed out or was cancelled');
            },
        });
    } finally {
        clearTimeout(timer);
        process.off('SIGINT', cancel);
        process.off('SIGTERM', cancel);
        rmSync(offerPath, { force: true });
        rmSync(wordsPath, { force: true });
    }
}
