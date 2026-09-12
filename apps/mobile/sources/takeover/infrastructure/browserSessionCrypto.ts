/**
 * Sealing for private signaling under the browser-service grant.
 *
 * The device seals every signal it sends and opens every reply with the
 * per-device root the browser service shares -- never the session root, so
 * the host relays bytes it cannot read. Bound to machine, service, device,
 * session and key version; replay-tracked per session.
 */

import {
    deriveV2Key,
    newV2ReplayTracker,
    newV2SenderState,
    openV2,
    sealV2,
    type V2Context,
} from '@muxr/crypto';
import type { BrowserServiceGrant } from '@/pairing/e2ee';

export interface BrowserSessionSealer {
    seal: (plaintext: string) => string;
    open: (sealed: string) => string;
}

// ponytail: adapter over the existing v2 envelope; swap the two calls for
// sealBrowserSessionMessage/openBrowserSessionMessage once the crypto lane
// exports them, keeping this interface.
export function browserSessionSealer(grant: BrowserServiceGrant, machineId: string, session: string): BrowserSessionSealer {
    const base = { machineId, channel: 'stream' as const, streamId: session, keyVersion: grant.keyVersion };
    const toService: V2Context = { ...base, senderId: grant.deviceId, recipientId: grant.serviceId };
    const fromService: V2Context = { ...base, senderId: grant.serviceId, recipientId: grant.deviceId };
    const sendKey = deriveV2Key(grant.root, 'client->host');
    const receiveKey = deriveV2Key(grant.root, 'host->client');
    const sender = newV2SenderState();
    const replay = newV2ReplayTracker();
    return {
        seal: (plaintext) => sealV2(plaintext, sendKey, toService, sender),
        open: (sealed) => openV2(sealed, receiveKey, fromService, replay),
    };
}
