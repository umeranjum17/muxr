/**
 * Sealing for private signaling under the browser-service grant.
 *
 * The device seals every signal it sends and opens every reply with the
 * per-device roots the browser service pinned -- never the session root, so
 * the host relays bytes it cannot read. The scope binds service, device,
 * session, ownership generation and key generation; one sealer per
 * generation, so nothing from an old seat opens under a new one.
 */

import {
    deriveBrowserSessionKeys,
    newV2ReplayTracker,
    newV2SenderState,
    openBrowserSessionMessage,
    sealBrowserSessionMessage,
    type BrowserSessionScope,
} from '@muxr/crypto';
import type { BrowserServiceGrant } from '@/pairing/e2ee';

export interface BrowserSessionSealer {
    seal: (message: unknown) => string;
    open: (sealed: string) => unknown;
}

export function browserSessionSealer(grant: BrowserServiceGrant, session: string, generation: number): BrowserSessionSealer {
    const keys = deriveBrowserSessionKeys({ dataKey: grant.dataKey, ingressKey: grant.ingressKey });
    const scope: BrowserSessionScope = { serviceId: grant.serviceId, deviceId: grant.deviceId, session, generation, keyVersion: grant.keyVersion };
    const sender = newV2SenderState();
    const replay = newV2ReplayTracker();
    return {
        seal: (message) => sealBrowserSessionMessage(message, keys, scope, 'device->service', sender),
        open: (sealed) => openBrowserSessionMessage(sealed, keys, scope, 'service->device', replay),
    };
}
