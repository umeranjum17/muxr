import { sync } from '@/catalog/sync';
import {
    captureStreamTransport,
    openRealtimeStream,
    type PluginStream,
    type RealtimeStreamSnapshot,
} from '@/plugins/openPluginStream';

/**
 * The product-owned realtime voice stream.
 *
 * It carries live microphone audio over the same relay channel and frame
 * protocol a plugin stream uses, but the host attaches muxr's own adapter
 * runtime instead of resolving a plugin contribution. The snapshot pins the
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
}): Promise<PluginStream> {
    return openRealtimeStream('voice.session', {
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        ...(options.machineId === undefined ? {} : { machineId: options.machineId }),
        ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }),
        attach: (params) => sync.request('voice.stream', params),
    });
}
