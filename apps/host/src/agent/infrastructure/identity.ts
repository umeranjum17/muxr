/**
 * Agent identity. One current schema: Human Name, Task Title, Provider Kind,
 * and an Agent Route. Herdr pane ids move; the route does not. Old or invalid
 * files are ignored and the map rebuilds from live Herdr.
 */

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { atomicWriteJson } from '../../platform/atomicWriteJson.js';
import { join } from 'node:path';
import {
    genericTaskTitle,
    humanKey,
    isValidHumanName,
    normalizeHuman,
    parseAgentIdentity,
    parseTaskTitle,
    taskTitleFor,
    type AgentAdoptInput,
    type AgentIdentity,
    type AgentObservation,
    type NameReservation,
} from '../domain/identity.js';

export {
    parseTaskTitle,
    taskTitleFor,
    type AgentAdoptInput,
    type AgentIdentity,
    type AgentObservation,
    type NameReservation,
};

const SCHEMA_VERSION = 4 as const;
const POOL = [
    'John', 'Maria', 'Alex', 'Maya', 'Sam',
    'Nina', 'Leo', 'Sara', 'Omar', 'Lina',
    'Noah', 'Zoe', 'Adam', 'Emma', 'Ryan',
    'Iris', 'Luke', 'Anna', 'Eli', 'Mila',
];

interface IdentityFile {
    schemaVersion: typeof SCHEMA_VERSION;
    sessions: AgentIdentity[];
}

function namedError(message: string, code: string): Error & { code: string } {
    const error = new Error(message) as Error & { code: string };
    error.code = code;
    return error;
}

function newSessionId(): string {
    return `pp_${randomBytes(4).toString('hex')}`;
}

export class IdentityStore {
    private readonly byId = new Map<string, AgentIdentity>();
    private readonly reserved = new Set<string>();
    private readonly file: string;
    private writeChain: Promise<void> = Promise.resolve();
    private writeError: unknown;

    constructor(dataDir: string) {
        this.file = join(dataDir, 'herdr-identity.json');
    }

    async load(): Promise<void> {
        this.byId.clear();
        try {
            const parsed = JSON.parse(await readFile(this.file, 'utf8')) as IdentityFile;
            if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.sessions)) return;
            for (const session of parsed.sessions) {
                const agent = parseAgentIdentity(session);
                if (agent !== undefined) this.byId.set(agent.sessionId, agent);
            }
        } catch {
            // Missing, corrupt, or old schema: start empty. Herdr is the truth.
        }
    }

    get(sessionId: string): AgentIdentity | undefined {
        return this.byId.get(sessionId);
    }

    byPane(paneId: string): AgentIdentity | undefined {
        for (const identity of this.byId.values()) {
            if (identity.paneId === paneId) return identity;
        }
        return undefined;
    }

    /** Agent Route: app-owned session id first, then the live pane id. */
    byRoute(agentName: string | undefined, paneId: string): AgentIdentity | undefined {
        if (agentName !== undefined) {
            const owned = this.byId.get(agentName);
            if (owned?.ours === true) return owned;
        }
        return this.byPane(paneId);
    }

    all(): AgentIdentity[] {
        return [...this.byId.values()];
    }

    remove(sessionId: string): void {
        this.byId.delete(sessionId);
        this.persist();
    }

    async flush(): Promise<void> {
        await this.writeChain;
        if (this.writeError !== undefined) throw this.writeError;
    }

    reserve(requested?: string): NameReservation {
        const explicit = requested?.trim();
        if (explicit !== undefined && explicit !== '') {
            const clean = normalizeHuman(explicit);
            if (!isValidHumanName(clean)) throw namedError('Choose a short human name, such as John or Maria.', 'invalid-display-name');
            const key = humanKey(clean);
            if (this.taken(key)) throw namedError('That agent name is already in use. Choose another name.', 'duplicate-display-name');
            this.reserved.add(key);
            return { sessionId: newSessionId(), displayName: clean, release: () => { this.reserved.delete(key); } };
        }
        const displayName = this.nextHumanName();
        const key = humanKey(displayName);
        this.reserved.add(key);
        return { sessionId: newSessionId(), displayName, release: () => { this.reserved.delete(key); } };
    }

    adopt(input: AgentAdoptInput): AgentIdentity {
        const identity: AgentIdentity = {
            sessionId: input.sessionId ?? newSessionId(),
            paneId: input.paneId,
            workspaceId: input.workspaceId,
            tabId: input.tabId,
            cwd: input.cwd,
            displayName: input.displayName,
            taskTitle: taskTitleFor(input.taskTitle, input.kind, input.displayName),
            createdAt: new Date().toISOString(),
            ours: input.ours,
            ...(input.kind === undefined ? {} : { kind: input.kind }),
            ...(input.agentName === undefined ? {} : { agentName: input.agentName }),
        };
        this.byId.set(identity.sessionId, identity);
        this.persist();
        return identity;
    }

    observe(live: AgentObservation): {
        identity: AgentIdentity;
        created: boolean;
        previousPaneId?: string;
        displaced?: AgentIdentity;
    } {
        const known = this.byRoute(live.agentName, live.previousPaneId ?? live.paneId);
        if (known !== undefined) {
            const displaced = this.displace(known, live.paneId);
            const identity = this.reconcile(known, live);
            if (displaced === undefined) return { identity, created: false, previousPaneId: known.paneId };
            return { identity, created: false, previousPaneId: known.paneId, displaced };
        }
        const displayName = this.nextHumanName();
        const kind = live.kind;
        const identity: AgentIdentity = {
            sessionId: newSessionId(),
            paneId: live.paneId,
            workspaceId: live.workspaceId ?? '',
            tabId: live.tabId ?? '',
            cwd: live.cwd ?? '/',
            displayName,
            taskTitle: this.observedTaskTitle(undefined, live, kind, displayName),
            createdAt: new Date().toISOString(),
            ours: false,
            ...(kind === undefined ? {} : { kind }),
            ...(live.agentName === undefined ? {} : { agentName: live.agentName }),
        };
        this.byId.set(identity.sessionId, identity);
        this.persist();
        return { identity, created: true };
    }

    bindRoute(sessionId: string, agentName: string): AgentIdentity | undefined {
        const current = this.byId.get(sessionId);
        if (current === undefined) return undefined;
        const identity = { ...current, agentName };
        this.byId.set(sessionId, identity);
        this.persist();
        return identity;
    }

    private displace(known: AgentIdentity, paneId: string): AgentIdentity | undefined {
        if (known.paneId === paneId) return undefined;
        const occupant = this.byPane(paneId);
        if (occupant === undefined || occupant.sessionId === known.sessionId) return undefined;
        this.remove(occupant.sessionId);
        return occupant;
    }

    private reconcile(known: AgentIdentity, live: AgentObservation): AgentIdentity {
        const kind = live.kind ?? known.kind;
        const agentName = live.agentName ?? known.agentName;
        const next: AgentIdentity = {
            sessionId: known.sessionId,
            paneId: live.paneId,
            workspaceId: live.workspaceId ?? known.workspaceId,
            tabId: live.tabId ?? known.tabId,
            cwd: live.cwd ?? known.cwd,
            displayName: known.displayName,
            taskTitle: this.observedTaskTitle(known, live, kind, known.displayName),
            createdAt: known.createdAt,
            ours: known.ours,
            ...(kind === undefined ? {} : { kind }),
            ...(agentName === undefined ? {} : { agentName }),
        };
        if (
            next.paneId === known.paneId
            && next.workspaceId === known.workspaceId
            && next.tabId === known.tabId
            && next.cwd === known.cwd
            && next.agentName === known.agentName
            && next.kind === known.kind
            && next.taskTitle === known.taskTitle
        ) return known;
        this.byId.set(next.sessionId, next);
        this.persist();
        return next;
    }

    private observedTaskTitle(
        known: AgentIdentity | undefined,
        live: AgentObservation,
        kind: string | undefined,
        displayName: string,
    ): string {
        if (known !== undefined && known.ours && known.taskTitle !== genericTaskTitle(known.kind)) {
            return known.taskTitle;
        }
        const fromTerminal = parseTaskTitle(live.terminalTitle, kind, displayName);
        if (fromTerminal !== undefined) return fromTerminal;
        const fromPane = parseTaskTitle(live.paneLabel, kind, displayName);
        if (fromPane !== undefined) return fromPane;
        const fromTab = parseTaskTitle(live.tabLabel, kind, displayName);
        if (fromTab !== undefined) return fromTab;
        if (known !== undefined) return known.taskTitle;
        return genericTaskTitle(kind);
    }

    private taken(key: string): boolean {
        return this.reserved.has(key) || this.all().some((agent) => humanKey(agent.displayName) === key);
    }

    private nextHumanName(): string {
        for (let round = 1; ; round += 1) {
            for (const name of POOL) {
                const candidate = round === 1 ? name : `${name} ${round}`;
                if (!this.taken(humanKey(candidate))) return candidate;
            }
        }
    }

    private persist(): void {
        const snapshot: IdentityFile = { schemaVersion: SCHEMA_VERSION, sessions: this.all() };
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
