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
import { pickHerdName } from './herdNames.js';

export interface HerdrIdentity {
    sessionId: string;
    paneId: string;
    workspaceId: string;
    tabId: string;
    agentName?: string;
    kind?: string;
    cwd: string;
    label?: string;
    /** Human-facing name. Stable across pane moves and never used for routing. */
    displayName: string;
    /** True only when muxr chose label from the fallback herd pool. */
    autoLabel?: boolean;
    createdAt: string;
    /** App-started (vs discovered on the herdr bus): drives discovery naming. */
    ours: boolean;
}

interface IdentityFile {
    sessions: HerdrIdentity[];
}

const DISPLAY_NAME = /^[\p{L}\p{M}][\p{L}\p{M}' -]{0,72}(?: \d+)?$/u;

function normalizeDisplayName(value: string): string {
    return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function displayKey(value: string): string {
    return normalizeDisplayName(value).toLowerCase();
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
            const sessions = [...(parsed.sessions ?? [])].sort((left, right) => left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0);
            const prepared = sessions.map((session) => {
                const legacy = session as HerdrIdentity & { displayName?: string };
                const candidate = legacy.displayName?.trim()
                    || (legacy.autoLabel !== true ? legacy.label?.trim() : undefined);
                const normalized = candidate === undefined ? undefined : normalizeDisplayName(candidate);
                return { session, candidate: normalized !== undefined && DISPLAY_NAME.test(normalized) ? normalized : undefined };
            });
            const reserved = new Set(prepared.flatMap(({ candidate }) => candidate === undefined ? [] : [displayKey(candidate)]));
            const used = new Set<string>();
            let migrated = false;
            for (const { session, candidate } of prepared) {
                let displayName = candidate ?? pickHerdName([...reserved, ...used]);
                if (used.has(displayKey(displayName))) {
                    let suffix = 2;
                    while (reserved.has(displayKey(`${displayName} ${suffix}`)) || used.has(displayKey(`${displayName} ${suffix}`))) suffix += 1;
                    displayName = `${displayName} ${suffix}`;
                }
                used.add(displayKey(displayName));
                migrated = migrated || session.displayName !== displayName;
                this.byId.set(session.sessionId, { ...session, displayName });
            }
            if (migrated) {
                this.persist();
                await this.writeChain;
            }
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
