import { sync } from '@/catalog/sync';
import {
    captureStreamTransport,
    openRealtimeStream,
    type RealtimeStream,
    type RealtimeStreamSnapshot,
} from '../infrastructure/realtimeStream';

/**
 * The product-owned realtime voice stream.
 *
 * It carries live microphone audio over the authenticated link to the
 * host-owned voice adapter runtime. The snapshot pins the
 * machine, relay and device grant exactly as before, so reconnect, hosted
 * encryption and end-before-switch behaviour are unchanged.
 */
export async function captureVoiceStreamSnapshot(machineId: string): Promise<RealtimeStreamSnapshot> {
    return captureStreamTransport('voice.session', machineId);
}

export async function openVoiceStream(options: {
    sessionId?: string;
    machineId?: string;
    snapshot?: RealtimeStreamSnapshot;
}): Promise<RealtimeStream> {
    return openRealtimeStream('voice.session', {
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        ...(options.machineId === undefined ? {} : { machineId: options.machineId }),
        ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }),
        openStream: (params) => sync.openVoiceStream(params) ?? Promise.resolve(undefined),
    });
}
