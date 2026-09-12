/**
 * Open a provider-neutral Surface offer from the local broker.
 *
 * Named use case so the broker and the tests share one validation path: the
 * contract parses the bounded input, this step checks the host-resolved
 * provider against installed claimants, and the registry binds the offer to
 * the exact live agent session. There is deliberately no device path here:
 * the required activation is agent/local broker into a host-originated
 * Surface frame, and a phone that could inject offers into other
 * controlling devices would only expand the attack surface. Mobile needs
 * `preview.lease` and `preview.release` in this slice, nothing else.
 */

import { parseSurfaceOfferInput, type SurfaceCapability } from '@muxr/contract';
import type { SurfaceOfferRecord, SurfaceOfferRegistry } from '../infrastructure/surfaceOffers.js';

export interface OpenSurfaceOfferPorts {
    offers: SurfaceOfferRegistry;
    /**
     * The catalog digest offers are issued under right now. Browser-local
     * offers need it to prove their provider is installed.
     */
    snapshot?(): Promise<string>;
    /**
     * Host-installed claimant plugin ids for a capability, from manifest
     * declarations. Every offer carries the resolved claimant, so every
     * kind needs its provider proven installed.
     */
    claimants(capability: SurfaceCapability): Promise<string[]>;
}

export interface OpenSurfaceOfferCommand {
    offer: unknown;
    context: unknown;
    /** Exact live agent session. The local broker always binds one. */
    sessionId?: string;
}

function snapshotHasProvider(snapshot: string, provider: string): boolean {
    if (provider === '') return false;
    return snapshot.split('|').some((entry) => entry.slice(0, entry.lastIndexOf(':')) === provider);
}

export async function openSurfaceOffer(
    ports: OpenSurfaceOfferPorts,
    command: OpenSurfaceOfferCommand,
): Promise<SurfaceOfferRecord> {
    const input = parseSurfaceOfferInput(command.offer);
    let installed: string[];
    try {
        installed = await ports.claimants(input.capability);
    } catch {
        throw new Error('this host cannot verify surface providers right now');
    }
    if (!installed.includes(input.provider)) {
        throw new Error('that surface provider is not enabled on this computer');
    }
    if (input.kind === 'browser-local' && ports.snapshot !== undefined) {
        let snapshot: string;
        try {
            snapshot = await ports.snapshot();
        } catch {
            throw new Error('this host cannot verify surface providers right now');
        }
        if (!snapshotHasProvider(snapshot, input.provider)) {
            throw new Error('that surface provider is not enabled on this computer');
        }
    }
    return ports.offers.open(command.offer, command.context, command.sessionId);
}
