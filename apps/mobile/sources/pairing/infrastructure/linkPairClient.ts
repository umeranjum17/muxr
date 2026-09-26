import {
    DeviceLink,
    LinkError,
    LINK_WORDS,
    b64url,
    keyPair as linkKeyPair,
    keyPairFrom,
    pairWithOffer,
    pendingGrant,
    unb64url,
    type DeviceGrant as LinkDeviceGrant,
} from '@byokit/link';

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
export { LinkError, LINK_WORDS, b64url, keyPairFrom, linkKeyPair, unb64url };

/** The machine display name for consent, parsed for display only; the pairing itself re-validates. */
export function linkOfferName(scanned: string, deviceName: string): string | undefined {
    try {
        return pendingGrant(scanned, { name: deviceName, key: linkKeyPair() }).hostName;
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
function openLink(grant: LinkDeviceGrant, timeoutMs: number, route?: (url: string) => string): Promise<{ link: DeviceLink; online: boolean; refused: boolean }> {
    return new Promise((resolve) => {
        let settled = false;
        const link = new DeviceLink(grant, {
            timeoutMs: 5_000,
            ...(route === undefined ? {} : { resolve: route }),
            onStatus: (status) => {
                if (settled) return;
                if (status === 'online') { settled = true; resolve({ link, online: true, refused: false }); }
                else if (status === 'removed' || status === 'refused') { settled = true; resolve({ link, online: false, refused: status === 'refused' }); }
            },
        });
        setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve({ link, online: false, refused: false });
        }, timeoutMs);
    });
}

/**
 * Claim the offer (fresh scan) or reconnect by key (resume), trade
 * `pair.complete` for the machine details, and prove this key over the
 * machine's real link. The proof only settles once the machine's link served
 * this key, so the caller learns the pairing truly reached the computer.
 */
export async function claimLinkPairing(pending: LinkPairPending, options: { mode: 'claim' | 'resume'; onWords?: (words: string) => void; tunnelPort?: number; onProven?: (answer: LinkPairAnswer, key: ReturnType<typeof keyPairFrom>) => Promise<void> }): Promise<LinkPairAnswer & { key: ReturnType<typeof keyPairFrom> }> {
    const resolve = options.tunnelPort === undefined ? undefined : (url: string) => {
        const target = new URL(url);
        target.protocol = 'ws:';
        target.host = `127.0.0.1:${options.tunnelPort}`;
        return target.toString();
    };
    const key = keyPairFrom(unb64url(pending.secretKey));
    const grant = pendingGrant(pending.scanned, { name: pending.name, key });
    let claim: LinkDeviceGrant;
    try {
        if (options.mode === 'claim') {
            // A fresh scan claims the single-use ticket; a resumed phone was
            // already approved, so it reconnects by its key alone — the ticket
            // burned on the first connection.
            claim = await pairWithOffer(pending.scanned, {
                name: pending.name,
                key,
                onWords: options.onWords ?? (() => undefined),
                ...(resolve === undefined ? {} : { resolve }),
            });
        } else {
            claim = grant;
        }
    } catch (cause) {
        throw cause instanceof Error ? cause : new Error('pairing failed');
    }
    // The pairing host lives in the `muxr pair` process; reconnect with the
    // grant it just approved to trade the machine details.
    const dial = await openLink(claim, 15_000, resolve);
    const pairing = dial.link;
    try {
        if (!dial.online) throw new Error(dial.refused ? LINK_WORDS['wrong-host'] : LINK_WORDS.unreachable);
        const answer = await pairing.request('pair.complete', { deviceName: pending.name }, { timeoutMs: 15_000 }) as unknown as LinkPairAnswer;
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
        await options.onProven?.(answer, key);
        await pairing.request('pair.verified', {}, { timeoutMs: 10_000 });
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
            throw new Error('the phone could not reach the computer over the link. Make sure muxr is running there, then run `muxr pair` again.');
        }
        await sleep(1_500);
    }
}
