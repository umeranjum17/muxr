/**
 * Browser-service grant and private session messages.
 *
 * Thin adapters over the existing primitives, no new cryptography:
 *
 * - The grant is an ordinary signed/X25519 device grant (`createDeviceGrant`)
 *   whose machine identity is the browser service itself. The device pins
 *   the service's signing key separately from the host's and verifies with
 *   `verifyDeviceGrant`; the roots inside are per device.
 * - Session messages are strict v2 envelopes (`sealV2`/`openV2`) under a
 *   directional key derived from those roots (`deriveV2Key`), with the
 *   context binding service id, device id, session handle, ownership
 *   generation and direction. A message sealed for one generation fails to
 *   open for the next, which is what makes a stale observer's permits and
 *   SDP worthless after Take control.
 */

import { createDeviceGrant } from './deviceGrant.js';
import type { SealedDeviceGrant } from '../domain/deviceGrant.js';
import {
    deriveV2Key,
    openV2,
    sealV2,
    type V2Context,
    type V2ReplayTracker,
    type V2SenderState,
} from './envelope.js';
import type { KeyPair } from '../infrastructure/keys.js';
import {
    browserSessionStreamId,
    validateBrowserSessionScope,
    type BrowserSessionDirection,
    type BrowserSessionScope,
} from '../domain/browserSession.js';

export type { BrowserSessionDirection, BrowserSessionScope } from '../domain/browserSession.js';

/** Mint the browser-service grant for one device. Called by the service only. */
export function mintBrowserServiceGrant(params: {
    serviceId: string;
    /** Service ed25519 signing secret key, base64. */
    serviceSigningSecretKey: string;
    /** Service X25519 keypair. */
    serviceKey: KeyPair;
    deviceId: string;
    devicePublicKey: string;
    /** Per-device 32-byte roots, base64 or bytes. */
    dataKey: string | Uint8Array;
    ingressKey: string | Uint8Array;
    keyVersion: number;
    expiresAt: number;
}): SealedDeviceGrant {
    return createDeviceGrant({
        machineId: params.serviceId,
        machineSigningSecretKey: params.serviceSigningSecretKey,
        machineKey: params.serviceKey,
        deviceId: params.deviceId,
        devicePublicKey: params.devicePublicKey,
        dataKey: params.dataKey,
        ingressKey: params.ingressKey,
        keyVersion: params.keyVersion,
        expiresAt: params.expiresAt,
        authority: 'control',
    });
}

export interface BrowserSessionKeys {
    /** Seals service->device; the device opens with it. */
    toDevice: string;
    /** Seals device->service; the service opens with it. */
    toService: string;
}

/** Both ends derive the same pair from the grant's roots. */
export function deriveBrowserSessionKeys(roots: { dataKey: string | Uint8Array; ingressKey: string | Uint8Array }): BrowserSessionKeys {
    return {
        toDevice: deriveV2Key(roots.dataKey, 'host->client'),
        toService: deriveV2Key(roots.ingressKey, 'client->host'),
    };
}

export function browserSessionContext(scope: BrowserSessionScope, direction: BrowserSessionDirection): V2Context {
    validateBrowserSessionScope(scope);
    const serviceSends = direction === 'service->device';
    return {
        machineId: scope.serviceId,
        senderId: serviceSends ? scope.serviceId : scope.deviceId,
        recipientId: serviceSends ? scope.deviceId : scope.serviceId,
        channel: 'stream',
        streamId: browserSessionStreamId(scope),
        keyVersion: scope.keyVersion,
    };
}

/** Seal one private message (SDP, ICE, permits, focus, heartbeat) for the scope. */
export function sealBrowserSessionMessage(
    message: unknown,
    keys: BrowserSessionKeys,
    scope: BrowserSessionScope,
    direction: BrowserSessionDirection,
    state: V2SenderState,
): string {
    const key = direction === 'service->device' ? keys.toDevice : keys.toService;
    return sealV2(JSON.stringify(message), key, browserSessionContext(scope, direction), state);
}

/** Open one private message. Fails closed on any scope, key, tamper or replay mismatch. */
export function openBrowserSessionMessage(
    envelope: string,
    keys: BrowserSessionKeys,
    scope: BrowserSessionScope,
    direction: BrowserSessionDirection,
    replay: V2ReplayTracker,
): unknown {
    const key = direction === 'service->device' ? keys.toDevice : keys.toService;
    const plaintext = openV2(envelope, key, browserSessionContext(scope, direction), replay);
    try {
        return JSON.parse(plaintext) as unknown;
    } catch {
        throw new Error('browser session: malformed message');
    }
}
