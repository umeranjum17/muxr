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
import { isPlaceholderLabel, pickHerdName } from './herdNames.js';

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
    /** Explicit or generic task identity. Never a routing key. */
    taskTitle?: string;
    /** True only when muxr chose label from the fallback herd pool. */
    autoLabel?: boolean;
    createdAt: string;
    /** App-started (vs discovered on the herdr bus): drives discovery naming. */
    ours: boolean;
}

export interface HerdrIdentityObservation {
    paneId: string;
    workspaceId?: string;
    tabId?: string;
    cwd?: string;
    agentName?: string;
    kind?: string;
    taskTitle?: string;
    displayName?: string;
}

export function reconcileHerdrIdentity(
    identity: HerdrIdentity,
    observed: HerdrIdentityObservation,
): HerdrIdentity {
    return {
        ...identity,
        paneId: observed.paneId,
        workspaceId: observed.workspaceId ?? identity.workspaceId,
        tabId: observed.tabId ?? identity.tabId,
        cwd: observed.cwd ?? identity.cwd,
        ...(observed.agentName === undefined ? {} : { agentName: observed.agentName }),
        ...(observed.kind === undefined ? {} : { kind: observed.kind }),
        ...(observed.taskTitle === undefined ? {} : { taskTitle: observed.taskTitle }),
        ...(observed.displayName === undefined ? {} : { displayName: observed.displayName }),
    };
}

interface IdentityFile {
    sessions: HerdrIdentity[];
}

const DISPLAY_NAME = /^[\p{L}\p{M}][\p{L}\p{M}' -]{0,72}(?: \d+)?$/u;

function normalizeDisplayName(value: string): string {
    return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function displayKey(value: string): string {
    return normalizeDisplayName(value).toLocaleLowerCase('und').replace(/ß/g, 'ss').replace(/ς/g, 'σ');
}

export function promotedHerdrDisplayName(
    identity: HerdrIdentity,
    candidate: string | undefined,
    identities: Iterable<HerdrIdentity>,
    reserved: Iterable<string> = [],
): string | undefined {
    if (!(identity.ours || identity.autoLabel === true) || candidate === undefined) return undefined;
    const clean = normalizeDisplayName(candidate);
    if (!DISPLAY_NAME.test(clean) || isPlaceholderLabel(clean)) return undefined;
    const key = displayKey(clean);
    const duplicate = [...identities].some((other) =>
        other.sessionId !== identity.sessionId && displayKey(other.displayName) === key,
    ) || [...reserved].some((name) => displayKey(name) === key);
    return duplicate ? undefined : clean;
}

export function newSessionId(): string {
    return `pp_${randomBytes(4).toString('hex')}`;
}

export class IdentityStore {
    private readonly byId = new Map<string, HerdrIdentity>();
    private readonly file: string;
    private writeChain: Promise<void> = Promise.resolve();
    private writeError: unknown;

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

    /** Stable app-owned agent token first; mutable pane id is only the fallback. */
    matchAgent(agentName: string | undefined, paneId: string): HerdrIdentity | undefined {
        if (agentName !== undefined) {
            const appOwned = this.byId.get(agentName);
            if (appOwned?.ours === true) return appOwned;
            const named = [...this.byId.values()].filter((identity) => identity.agentName === agentName);
            if (named.length === 1) return named[0];
        }
        return this.byPane(paneId);
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

    async flush(): Promise<void> {
        await this.writeChain;
        if (this.writeError !== undefined) throw this.writeError;
    }

    private persist(): void {
        const snapshot: IdentityFile = { sessions: this.all() };
        this.writeChain = this.writeChain.then(async () => {
            try {
                await atomicWriteJson(this.file, snapshot);
                this.writeError = undefined;
            } catch (error) {
                this.writeError = error;
            }
        });
    }
}
