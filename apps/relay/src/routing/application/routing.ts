import type { Envelope } from '@muxr/contract';
import { enqueuePushWebhook } from '../../push/index.js';
import type { PushWebhookConfig } from '../../push/index.js';
import { sendEnvelope, type ConnectedPeer, type PeerTable } from '../infrastructure/peers.js';
import type { RelayDirection, ReplayLog } from '../infrastructure/replay.js';
import type { OfflineBuffer } from '../infrastructure/buffer.js';
import { envelopeTargetRole, peerRouteOutcome, tenantMachineKey, type PeerRouteOutcome } from '../domain/envelopeRoute.js';

export interface RouteMetrics {
    delivered: number;
    buffered: boolean;
    pushNotified: boolean;
}

export type { PeerRouteOutcome };

export interface RouteContext {
    pushWebhook?: PushWebhookConfig;
    onPeerRoute?: (outcome: PeerRouteOutcome) => void;
}

export function routeEnvelope(
    envelope: Envelope,
    from: ConnectedPeer,
    peers: PeerTable,
    offline: OfflineBuffer,
    replay: ReplayLog,
    ctx: RouteContext = {},
): RouteMetrics {
    const targetRole = envelopeTargetRole(from.role);
    const machineId = envelope.header.machineId;
    const direction: RelayDirection = targetRole === 'client' ? 'toClient' : 'toMachine';
    const routingKey = tenantMachineKey(from.accountId, machineId);

    replay.record(routingKey, direction, envelope);

    let delivered = 0;
    for (const peer of peers.forMachine(machineId, targetRole, from.accountId)) {
        sendEnvelope(peer.socket, envelope);
        delivered += 1;
    }
    if (from.identity.deviceKind === 'peer' && targetRole === 'machine') {
        ctx.onPeerRoute?.(peerRouteOutcome(delivered, peers.forMachine(machineId, targetRole).length > 0));
    }

    if (delivered === 0 && targetRole === 'machine') {
        offline.enqueue(routingKey, envelope);
        return { delivered: 0, buffered: true, pushNotified: false };
    }

    if (delivered === 0 && targetRole === 'client' && ctx.pushWebhook !== undefined) {
        enqueuePushWebhook(ctx.pushWebhook, {
            machineId,
            ...(envelope.header.sessionId === undefined ? {} : { sessionId: envelope.header.sessionId }),
            at: envelope.header.at,
        });
        return { delivered: 0, buffered: false, pushNotified: true };
    }

    return { delivered, buffered: false, pushNotified: false };
}

export function deliverReplayAndOffline(
    peer: ConnectedPeer,
    offline: OfflineBuffer,
    replay: ReplayLog,
    accept?: (envelope: Envelope) => boolean,
): void {
    const direction: RelayDirection = peer.role === 'client' ? 'toClient' : 'toMachine';

    for (const machineId of peer.machineIds) {
        const routingKey = tenantMachineKey(peer.accountId, machineId);
        if (peer.lastSeenSeq !== undefined) {
            for (const envelope of replay.replay(routingKey, direction, peer.lastSeenSeq)) {
                if (accept !== undefined && !accept(envelope)) continue;
                sendEnvelope(peer.socket, envelope);
            }
        }

        if (peer.role === 'machine') {
            for (const envelope of offline.drain(routingKey)) {
                if (accept !== undefined && !accept(envelope)) continue;
                sendEnvelope(peer.socket, envelope);
            }
        }
    }
}
