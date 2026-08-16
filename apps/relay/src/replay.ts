import { join } from 'node:path';
import type { Envelope } from '@muxr/contract';
import { chainPersist, readPrivateFile, writeJsonFileAtomic } from './persist.js';

export type RelayDirection = 'toClient' | 'toMachine';

export interface ReplayEntry {
    direction: RelayDirection;
    envelope: Envelope;
    storedAt: number;
}

interface ReplayFile {
    byMachine: Record<string, ReplayEntry[]>;
}

export class ReplayLog {
    private readonly filePath: string;
    private readonly limit: number;
    private readonly ttlMs: number;
    private byMachine = new Map<string, ReplayEntry[]>();
    private persistQueued = false;
    private persistDirty = false;

    constructor(dataDir: string, limit: number, ttlMs: number) {
        this.filePath = join(dataDir, 'replay-log.json');
        this.limit = limit;
        this.ttlMs = ttlMs;
    }

    async load(): Promise<void> {
        const raw = await readPrivateFile(this.filePath);
        if (raw === undefined) return;
        const parsed = JSON.parse(raw) as ReplayFile;
        this.byMachine = new Map(Object.entries(parsed.byMachine ?? {}));
        this.pruneExpired();
    }

    private pruneExpired(now = Date.now()): void {
        for (const [machineId, entries] of this.byMachine) {
            const kept = entries.filter((entry) => now - entry.storedAt <= this.ttlMs);
            if (kept.length === 0) this.byMachine.delete(machineId);
            else this.byMachine.set(machineId, kept);
        }
    }

    private trim(machineId: string): void {
        const entries = this.byMachine.get(machineId);
        if (!entries) return;
        if (entries.length <= this.limit) return;
        this.byMachine.set(machineId, entries.slice(entries.length - this.limit));
    }

    private persist(): void {
        this.persistDirty = true;
        if (this.persistQueued) return;
        this.persistQueued = true;
        chainPersist(async () => {
            try {
                // Reconnect replay is crash-recovery state, not a per-frame
                // fsync contract. Collapse bursts instead of rewriting the
                // full log for every envelope.
                await new Promise((resolve) => setTimeout(resolve, 1_000));
                while (this.persistDirty) {
                    this.persistDirty = false;
                    const payload: ReplayFile = { byMachine: Object.fromEntries(this.byMachine) };
                    await writeJsonFileAtomic(this.filePath, payload);
                    if (this.persistDirty) await new Promise((resolve) => setTimeout(resolve, 1_000));
                }
            } catch (error) {
                this.persistDirty = true;
                throw error;
            } finally {
                this.persistQueued = false;
                if (this.persistDirty) this.persist();
            }
        });
    }

    record(machineId: string, direction: RelayDirection, envelope: Envelope): void {
        this.pruneExpired();
        const entries = this.byMachine.get(machineId) ?? [];
        entries.push({ direction, envelope, storedAt: Date.now() });
        this.byMachine.set(machineId, entries);
        this.trim(machineId);
        this.persist();
    }

    /** Returns envelopes with header.seq strictly greater than lastSeq for the given direction. */
    replay(machineId: string, direction: RelayDirection, lastSeq: number): Envelope[] {
        this.pruneExpired();
        const entries = this.byMachine.get(machineId) ?? [];
        return entries
            .filter((entry) => entry.direction === direction && entry.envelope.header.seq > lastSeq)
            .sort((a, b) => a.envelope.header.seq - b.envelope.header.seq)
            .map((entry) => entry.envelope);
    }

    totalStored(): number {
        let total = 0;
        for (const entries of this.byMachine.values()) total += entries.length;
        return total;
    }
}
