import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Ticket } from './auth.js';
import { readPrivateFile, writeJsonFileAtomic } from './persist.js';

const TICKET_TTL_MS = 60_000;
const MAX_TICKETS = 1000;

interface StoredTicket extends Ticket {
    ticketHash: string;
    expiresAt: number;
    usedAt?: number;
}

const hash = (ticket: string): string => createHash('sha256').update(ticket).digest('base64url');

/**
 * File-backed one-use WebSocket ticket issuer for self-host relays. No Mongo,
 * no control plane: the CLI mints a ticket on the box (mint secret in dataDir)
 * and the phone/host presents it within 60 seconds.
 */
export class FileTicketStore {
    private readonly file: string;
    private tickets: StoredTicket[] = [];
    /** Synchronous in-process claims: set before any await so concurrent consumes cannot race. */
    private readonly claimed = new Set<string>();
    /** Serializes read–modify–write so concurrent issue/consume cannot lose updates. */
    private queue: Promise<void> = Promise.resolve();

    constructor(dataDir: string) {
        this.file = join(dataDir, 'tickets.json');
    }

    private serialized<T>(op: () => Promise<T>): Promise<T> {
        const run = this.queue.then(op);
        this.queue = run.then(() => undefined, () => undefined);
        return run;
    }

    private async load(): Promise<void> {
        const raw = await readPrivateFile(this.file);
        if (raw === undefined) {
            this.tickets = [];
            return;
        }
        try {
            this.tickets = JSON.parse(raw) as StoredTicket[];
        } catch {
            this.tickets = [];
        }
    }

    private prune(now: number): void {
        this.tickets = this.tickets.filter((t) => t.expiresAt > now).slice(-MAX_TICKETS);
    }

    async issue(input: Ticket, now = Date.now()): Promise<string> {
        return this.serialized(async () => {
            await this.load();
            this.prune(now);
            const ticket = `muxr_tk_${randomBytes(24).toString('base64url')}`;
            this.tickets.push({ ...input, ticketHash: hash(ticket), expiresAt: now + TICKET_TTL_MS });
            await writeJsonFileAtomic(this.file, this.tickets);
            return ticket;
        });
    }

    /** Single-use consume: expired or spent tickets never authenticate. Reloads first so a writer in another process cannot be clobbered. */
    async consume(ticket: string, now = Date.now()): Promise<Ticket | undefined> {
        const ticketHash = hash(ticket);
        if (this.claimed.has(ticketHash)) return undefined;
        this.claimed.add(ticketHash);
        return this.serialized(async () => {
            await this.load();
            // Bound the claim set to live file state (pruned to MAX_TICKETS). If the
            // file is unreadable this wipes `claimed` — safe: the lookup below also
            // fails on a missing record, so nothing authenticates. Do not reorder.
            const live = new Set(this.tickets.map((t) => t.ticketHash));
            for (const h of this.claimed) if (!live.has(h)) this.claimed.delete(h);
            const found = this.tickets.find((t) => t.ticketHash === ticketHash);
            if (found === undefined || found.usedAt !== undefined || found.expiresAt <= now) return undefined;
            found.usedAt = now;
            await writeJsonFileAtomic(this.file, this.tickets);
            const { ticketHash: _h, expiresAt: _e, usedAt: _u, ...ticketData } = found;
            return ticketData;
        });
    }
}
