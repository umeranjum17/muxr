/**
 * Session identity. Herdr's handles are mutable -- pane ids change on
 * cross-workspace moves, agent names are user-renameable -- so muxr
 * sessions get their own `pp_<hex>` ids and this file is the map back to
 * whatever herdr currently calls the pane.
 */

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { atomicWriteJson } from '../domain/atomicWriteJson.js';
import { join } from 'node:path';

export interface HerdrIdentity {
    sessionId: string;
    paneId: string;
    workspaceId: string;
    tabId: string;
    agentName?: string;
    kind?: string;
    cwd: string;
    label?: string;
    /** True only when muxr chose label from the fallback herd pool. */
    autoLabel?: boolean;
    createdAt: string;
    /** App-started (vs discovered on the herdr bus): drives discovery naming. */
    ours: boolean;
}

interface IdentityFile {
    sessions: HerdrIdentity[];
}

export function newSessionId(): string {
    return `pp_${randomBytes(4).toString('hex')}`;
}

export class IdentityStore {
    private readonly byId = new Map<string, HerdrIdentity>();
    private readonly file: string;
    private writeChain: Promise<void> = Promise.resolve();

    constructor(dataDir: string) {
        this.file = join(dataDir, 'herdr-identity.json');
    }

    async load(): Promise<void> {
        try {
            const parsed = JSON.parse(await readFile(this.file, 'utf8')) as IdentityFile;
            for (const session of parsed.sessions ?? []) this.byId.set(session.sessionId, session);
        } catch {
            // Missing or corrupt file: start empty. Herdr is the truth; the map rebuilds.
        }
    }

    get(sessionId: string): HerdrIdentity | undefined {
        return this.byId.get(sessionId);
    }

    byPane(paneId: string): HerdrIdentity | undefined {
        for (const identity of this.byId.values()) {
            if (identity.paneId === paneId) return identity;
        }
        return undefined;
    }

    all(): HerdrIdentity[] {
        return [...this.byId.values()];
    }

    put(identity: HerdrIdentity): void {
        this.byId.set(identity.sessionId, identity);
        this.persist();
    }

    remove(sessionId: string): void {
        this.byId.delete(sessionId);
        this.persist();
    }

    private persist(): void {
        const snapshot: IdentityFile = { sessions: this.all() };
        this.writeChain = this.writeChain.then(() => atomicWriteJson(this.file, snapshot)).catch(() => {});
    }
}
