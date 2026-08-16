import { join } from 'node:path';
import type { Envelope } from '@muxr/contract';
import { chainPersist, readPrivateFile, writeJsonFileAtomic } from './persist.js';

export interface BufferedFrame {
    envelope: Envelope;
    enqueuedAt: number;
}

interface OfflineBufferFile {
    queues: Record<string, BufferedFrame[]>;
    droppedCount: number;
}

export class OfflineBuffer {
    private readonly filePath: string;
    private readonly limit: number;
    private readonly ttlMs: number;
    private queues = new Map<string, BufferedFrame[]>();
    droppedCount = 0;

    constructor(dataDir: string, limit: number, ttlMs: number) {
        this.filePath = join(dataDir, 'offline-buffer.json');
        this.limit = limit;
        this.ttlMs = ttlMs;
    }

    async load(): Promise<void> {
        const raw = await readPrivateFile(this.filePath);
        if (raw === undefined) return;
        const parsed = JSON.parse(raw) as OfflineBufferFile;
        this.droppedCount = parsed.droppedCount ?? 0;
        this.queues = new Map(Object.entries(parsed.queues ?? {}));
        this.pruneExpired();
    }

    private pruneExpired(now = Date.now()): void {
        for (const [machineId, queue] of this.queues) {
            const kept = queue.filter((item) => now - item.enqueuedAt <= this.ttlMs);
            if (kept.length !== queue.length) {
                this.droppedCount += queue.length - kept.length;
            }
            if (kept.length === 0) this.queues.delete(machineId);
            else this.queues.set(machineId, kept);
        }
    }

    private persist(): void {
        const payload: OfflineBufferFile = {
            queues: Object.fromEntries(this.queues),
            droppedCount: this.droppedCount,
        };
        chainPersist(() => writeJsonFileAtomic(this.filePath, payload));
    }

    enqueue(machineId: string, envelope: Envelope): void {
        this.pruneExpired();
        const queue = this.queues.get(machineId) ?? [];
        queue.push({ envelope, enqueuedAt: Date.now() });

        while (queue.length > this.limit) {
            queue.shift();
            this.droppedCount += 1;
        }

        this.queues.set(machineId, queue);
        this.persist();
    }

    drain(machineId: string): Envelope[] {
        this.pruneExpired();
        const queue = this.queues.get(machineId);
        if (!queue?.length) return [];
        this.queues.delete(machineId);
        this.persist();
        return queue.map((item) => item.envelope);
    }

    totalBuffered(): number {
        let total = 0;
        for (const queue of this.queues.values()) total += queue.length;
        return total;
    }
}
