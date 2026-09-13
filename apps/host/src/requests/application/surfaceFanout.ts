/**
 * Surface offer fanout: the registry records what a surface may show; this
 * turns a registry event into the bounded `surface.offer` HostFrame the host
 * sends on the session channel.
 */

import type { SurfaceOfferHostFrame } from '@muxr/contract';
import type { SurfaceOfferEvent, SurfaceOfferRecord } from '../infrastructure/surfaceOffers.js';

export type SurfaceOfferFanoutOperation = SurfaceOfferEvent['operation'];

/** The bounded frame for a registry event. Sessionless records emit nothing. */
export function surfaceOfferFrame(event: SurfaceOfferEvent): SurfaceOfferHostFrame | undefined {
    const record: SurfaceOfferRecord = event.record;
    if (record.sessionId === undefined) return undefined;
    return {
        type: 'surface.offer',
        operation: event.operation,
        handle: record.handle,
        sessionId: record.sessionId,
        revision: record.revision,
        expiresAt: record.expiresAt,
        command: record.command,
        ...(event.operation === 'close' ? {} : { offer: record.offer }),
    };
}
