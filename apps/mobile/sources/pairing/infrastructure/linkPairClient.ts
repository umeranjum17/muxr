import { encodeBase64 } from '@/encryption/base64';
import type { StoredHostedGrant } from '../application/linkPairing';
import {
    DeviceLink,
    LinkError,
    LINK_WORDS,
    b64url,
    decodeCompactOffer,
    keyPair as linkKeyPair,
    keyPairFrom,
    pairWithOffer,
    parseOffer,
    unb64url,
    type DeviceGrant as LinkDeviceGrant,
} from '@byokit/link';
import { isCompactOfferText, linkOfferExpired, PairingNeedsNewCode } from '../domain/pairingString';

/**
 * The byokit pairing protocol, behind one port: application code asks this
 * adapter to claim an offer or resume a pending pairing and receives the raw
 * machine answer. No application file imports @byokit/link, and nothing here
 * decides how the session channel is carried — that stays in LinkFirstClient.
 */

export interface LinkPairPending {
    scanned: string;
    name: string;
    /** base64url; persisted by the caller before the first connection. */
    secretKey: string;
    /** The machine details, persisted once this key proved itself and before `pair.verified` is sent. */
    answer?: LinkPairAnswer;
}

export interface LinkPairAnswer {
    machineId: string;
    machineName: string;
    machineBoxPublicKey: string;
    relayUrl: string;
    deviceId: string;
    authority: 'control' | 'observe';
    expiresAt: number;
    linkUrl: string;
}

export type { LinkDeviceGrant };
export function newPairingSecretKey(): string {
    return b64url(linkKeyPair().secretKey);
}

export function pairingFailure(cause: unknown): string {
    return cause instanceof LinkError && cause.code in LINK_WORDS
        ? LINK_WORDS[cause.code] : cause instanceof Error ? cause.message : String(cause);
}

const NOT_FINISHED = "This pairing didn't finish on your computer. Run `muxr pair` there and scan the new code.";
/** byokit keys are base64url; the machine answer keeps the same bytes as plain base64. */
const toBase64Url = (value: string): string => value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** The computer revoked this key mid-request: it rolled the pairing back. */
const rolledBack = (cause: unknown): boolean => cause instanceof LinkError && cause.code === 'removed';
const lost = (cause: unknown): boolean => cause instanceof LinkError && (cause.code === 'unreachable' || cause.code === 'timeout');
/** The computer answers this once its pairing has closed, whether it kept this device or rolled it back. */
const pairingClosed = (cause: unknown): boolean => cause instanceof LinkError && (cause.code === 'not-allowed' || cause.code === 'view-only');

export function provenLinkGrant(answer: LinkPairAnswer, key: { publicKey: Uint8Array; secretKey: Uint8Array }): StoredHostedGrant {
    const deviceKey = {
        publicKey: encodeBase64(key.publicKey),
        secretKey: encodeBase64(key.secretKey),
    };
    return {
        machineId: answer.machineId,
        machineSigningPublicKey: '',
        deviceId: answer.deviceId,
        devicePublicKey: deviceKey.publicKey,
        keyVersion: 1,
        expiresAt: answer.expiresAt,
        authority: answer.authority,
        deviceKey,
        machineBoxPublicKey: encodeBase64(unb64url(answer.machineBoxPublicKey)),
        credential: '',
        dataKey: '',
        ingressKey: '',
        relayUrl: answer.relayUrl,
        linkUrl: answer.linkUrl,
        machineName: answer.machineName,
        source: 'selfhost',
    };
}

export function isBrowserLinkOffer(scanned: string): boolean {
    return /^https:\/\/[^#]+\/pair#byokit-link:1:/.test(scanned);
}

/** The machine display name for consent, parsed for display only; the pairing itself re-validates. */
export function linkOfferName(scanned: string): string | undefined {
    try {
        return parseOffer(scanned, 0).name;
    } catch {
        // Not v1: read the name from a compact offer the same way.
    }
    try {
        return decodeCompactOffer(scanned, 0).name;
    } catch {
        return undefined;
    }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Dial one link address and wait for the handshake to settle. Resolves with
 * the (still-open) link plus how it settled: `online`, or `refused` when
 * something other than the expected host answered, or neither inside
 * `timeoutMs`. The caller owns `link.stop()` in every case.
 */
function openLink(grant: LinkDeviceGrant, timeoutMs: number, route?: (url: string) => string): Promise<{ link: DeviceLink; online: boolean; refused: boolean; removed: boolean }> {
    return new Promise((resolve) => {
        let settled = false;
        const link = new DeviceLink(grant, {
            timeoutMs: 5_000,
            ...(route === undefined ? {} : { resolve: route }),
            onStatus: (status) => {
                if (settled) return;
                if (status === 'online') { settled = true; resolve({ link, online: true, refused: false, removed: false }); }
                else if (status === 'removed' || status === 'refused') { settled = true; resolve({ link, online: false, refused: status === 'refused', removed: status === 'removed' }); }
            },
        });
        setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve({ link, online: false, refused: false, removed: false });
        }, timeoutMs);
    });
}

/**
 * Claim the offer (fresh scan) or reconnect by key (resume), trade
 * `pair.complete` for the machine details, and prove this key over the
 * machine's real link. The proof only settles once the machine's link served
 * this key, so the caller learns the pairing truly reached the computer.
 */
export async function claimLinkPairing(pending: LinkPairPending, options: { mode: 'claim' | 'resume'; onWords?: (words: string) => void; tunnelPort?: number; onClaimed?: () => Promise<void>; onProven?: (answer: LinkPairAnswer) => Promise<void> }): Promise<LinkPairAnswer & { key: ReturnType<typeof keyPairFrom> }> {
    const resolve = options.tunnelPort === undefined ? undefined : (url: string) => {
        const target = new URL(url);
        target.protocol = 'ws:';
        target.host = `127.0.0.1:${options.tunnelPort}`;
        return target.toString();
    };
    const key = keyPairFrom(unb64url(pending.secretKey));
    let claim: LinkDeviceGrant;
    let wordsShown = false;
    try {
        if (options.mode === 'claim') {
            if (linkOfferExpired(pending.scanned)) throw new LinkError('expired');
            // A fresh scan claims the single-use ticket; a resumed phone was
            // already approved, so it reconnects by its key alone — the ticket
            // burned on the first connection. The kit's pairWithOffer reads
            // both the full v1 offer and the compact offer.
            claim = await pairWithOffer(pending.scanned, {
                name: pending.name,
                key,
                onWords: (words) => { wordsShown = true; options.onWords?.(words); },
                ...(resolve === undefined ? {} : { resolve }),
            });
        } else if (isCompactOfferText(pending.scanned)) {
            // The compact form carries no host key, so only a pairing that
            // already traded pair.complete can resume by key. A phone killed
            // during the words/approval step rescans: the kit's pendingGrant
            // resume is v1-only.
            if (pending.answer === undefined) throw new PairingNeedsNewCode(NOT_FINISHED);
            claim = { v: 1, secretKey: pending.secretKey, host: toBase64Url(pending.answer.machineBoxPublicKey),
                hostName: pending.answer.machineName, urls: [pending.answer.linkUrl],
                device: { id: '', name: pending.name, role: pending.answer.authority === 'observe' ? 'view' : 'control' } };
        } else {
            // By key alone, past the code's expiry and with no grace for a key
            // the computer does not know: either it approved this key, or the
            // pairing it belonged to is over.
            const offer = parseOffer(pending.scanned, 0);
            claim = { v: 1, secretKey: pending.secretKey, host: offer.host, hostName: offer.name, urls: offer.urls,
                device: { id: '', name: pending.name, role: offer.role ?? 'view' } };
        }
    } catch (cause) {
        // The computer only grants a device whose link is still open when it
        // approves, and the code is single-use: neither can be retried.
        if (wordsShown && lost(cause)) {
            throw new PairingNeedsNewCode('The pairing link closed after the two words, before approval completed. Run `muxr pair` again and approve the fresh code before it expires.');
        }
        if (cause instanceof LinkError && (cause.code === 'expired' || cause.code === 'declined')) throw new PairingNeedsNewCode(LINK_WORDS[cause.code]);
        throw cause instanceof Error ? cause : new Error('pairing failed');
    }
    if (options.mode === 'claim') await options.onClaimed?.();
    // The pairing host lives in the `muxr pair` process; reconnect with the
    // grant it just approved to trade the machine details.
    const dial = await openLink(claim, 15_000, resolve);
    const pairing = dial.link;
    try {
        // The computer forgot this key: it ended the pairing and rolled it back.
        if (dial.removed) throw new PairingNeedsNewCode(NOT_FINISHED);
        if (!dial.online) throw new Error(dial.refused ? LINK_WORDS['wrong-host'] : "Approved, but the phone couldn't reach your computer to finish. Check it's on, then try again.");
        let answer: LinkPairAnswer;
        try { answer = await pairing.request('pair.complete', { deviceName: pending.name }, { timeoutMs: 15_000 }) as unknown as LinkPairAnswer; }
        catch (cause) {
            // Closed, yet this key still connects: the computer revokes a
            // rolled-back device as its pairing closes, so it kept this one
            // only because the acknowledgement landed.
            if (pairingClosed(cause)) {
                if (pending.answer !== undefined) return { ...pending.answer, key };
                throw new PairingNeedsNewCode(NOT_FINISHED);
            }
            if (rolledBack(cause)) throw new PairingNeedsNewCode(NOT_FINISHED);
            if (lost(cause)) throw new Error("Approved, but your computer didn't send its details in time. Try again.");
            throw cause;
        }
        if (typeof answer?.machineId !== 'string' || typeof answer?.machineBoxPublicKey !== 'string'
            || typeof answer?.linkUrl !== 'string' || !/^wss?:\/\//.test(answer.linkUrl)
            || typeof answer?.relayUrl !== 'string' || typeof answer?.deviceId !== 'string'
            || (answer.authority !== 'observe' && answer.authority !== 'control')
            || !Number.isFinite(answer.expiresAt) || answer.expiresAt <= Date.now()) {
            throw new Error('the computer sent an incomplete pairing answer');
        }
        await verifyMachineLink(answer, key, pending.name, resolve);
        // Persist before acknowledging: if the reply is lost after the computer
        // commits, both sides still hold the same device rather than an orphan.
        await options.onProven?.(answer);
        try { await pairing.request('pair.verified', {}, { timeoutMs: 10_000 }); }
        catch (cause) {
            if (rolledBack(cause)) throw new PairingNeedsNewCode(NOT_FINISHED);
            // Nothing says whether the computer saved this device; a retry
            // resumes by key and finds out instead of claiming a spent code.
            if (lost(cause) || pairingClosed(cause)) throw new Error('Your computer may not have saved this pairing. Try again to finish — no new code needed.');
            throw cause;
        }
        return { ...answer, key };
    } finally {
        pairing.stop();
    }
}

/**
 * Prove this phone over the machine's own link: the computer only finishes the
 * pairing once a device with our key connects there. A first dial can race the
 * machine enrolling us from the record it just wrote, so a refusal retries
 * inside the computer's proof window instead of failing the pairing.
 */
async function verifyMachineLink(answer: LinkPairAnswer, key: ReturnType<typeof keyPairFrom>, name: string, resolve?: (url: string) => string): Promise<void> {
    const grant: LinkDeviceGrant = {
        v: 1,
        secretKey: b64url(key.secretKey),
        host: answer.machineBoxPublicKey,
        hostName: answer.machineName,
        urls: [answer.linkUrl],
        device: { id: '', name, role: answer.authority === 'observe' ? 'view' : 'control' },
    };
    const deadline = Date.now() + 45_000;
    while (true) {
        const dial = await openLink(grant, 8_000, resolve);
        try {
            // The handshake itself proves the key reached the machine.
            if (dial.online) return;
            if (dial.refused) throw new Error(LINK_WORDS['wrong-host']);
        } finally {
            dial.link.stop();
        }
        // `removed` here usually means the machine has not enrolled this key
        // yet (the record was written moments ago); retry inside the proof
        // window before failing the pairing.
        if (Date.now() >= deadline) {
            throw new Error("The phone couldn't reach your computer to finish. Make sure muxr is running there, then try again.");
        }
        await sleep(1_500);
    }
}
