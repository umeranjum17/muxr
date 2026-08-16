import type { WebSocket } from 'ws';
import type { PeerIdentity } from './auth.js';

export type PeerRole = 'machine' | 'client';

export interface ConnectedPeer {
    socket: WebSocket;
    identity: PeerIdentity;
    /** Tenant namespace. Explicit local fixture peers share the reserved local scope. */
    accountId: string;
    role: PeerRole;
    /** Subscribed machine ids. Singleton for machine peers; many for client peers. */
    machineIds: ReadonlySet<string>;
    connectedAt: number;
    /** Undefined means fresh connect — skip replay. Set only when ?lastSeq= is present. */
    lastSeenSeq?: number;
}

export class PeerTable {
    private readonly peers = new Set<ConnectedPeer>();

    add(peer: ConnectedPeer): void {
        this.peers.add(peer);
    }

    remove(peer: ConnectedPeer): void {
        this.peers.delete(peer);
    }

    forMachine(machineId: string, role: PeerRole, accountId?: string): ConnectedPeer[] {
        const matches: ConnectedPeer[] = [];
        for (const peer of this.peers) {
            if (!peer.machineIds.has(machineId) || peer.role !== role || (accountId !== undefined && peer.accountId !== accountId)) continue;
            if (peer.socket.readyState !== peer.socket.OPEN) continue;
            matches.push(peer);
        }
        return matches;
    }

    hasOnlineClients(machineId: string): boolean {
        return this.forMachine(machineId, 'client').length > 0;
    }

    onlineMachineIds(): Set<string> {
        const ids = new Set<string>();
        for (const peer of this.peers) {
            if (peer.role !== 'machine' || peer.socket.readyState !== peer.socket.OPEN) continue;
            for (const machineId of peer.machineIds) ids.add(machineId);
        }
        return ids;
    }

    counts(): { machines: number; clients: number; total: number } {
        let machines = 0;
        let clients = 0;
        for (const peer of this.peers) {
            if (peer.socket.readyState !== peer.socket.OPEN) continue;
            if (peer.role === 'machine') machines += 1;
            else clients += 1;
        }
        return { machines, clients, total: machines + clients };
    }

    closeAll(): void {
        for (const peer of this.peers) peer.socket.terminate();
        this.peers.clear();
    }
}

export function sendEnvelope(socket: WebSocket, envelope: unknown): void {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(envelope));
}

export function parseLastSeq(url: URL): number | undefined {
    const raw = url.searchParams.get('lastSeq');
    if (raw === null) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

export function peerMayRoute(envelopeMachineId: string, peer: ConnectedPeer): boolean {
    return peer.machineIds.has(envelopeMachineId);
}
