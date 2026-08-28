/**
 * Agent identity. Herdr's agent.name is the canonical Agent Name; this store
 * only keeps muxr's stable Agent Route and the last observed topology.
 */

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { atomicWriteJson } from '../../platform/atomicWriteJson.js';
import { join } from 'node:path';
import {
    normalizeAgentName,
    genericTaskTitle,
    parseAgentIdentity,
    parseTaskTitle,
    taskTitleFor,
    type AgentAdoptInput,
    type AgentIdentity,
    type AgentObservation,
} from '../domain/identity.js';

export {
    normalizeAgentName,
    parseTaskTitle,
    taskTitleFor,
    type AgentAdoptInput,
    type AgentIdentity,
    type AgentObservation,
};
const SCHEMA_VERSION = 5 as const;

interface IdentityFile {
    schemaVersion: typeof SCHEMA_VERSION;
    sessions: AgentIdentity[];
}


function newSessionId(): string {
    return `pp_${randomBytes(4).toString('hex')}`;
}

export class IdentityStore {
    private readonly byId = new Map<string, AgentIdentity>();
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

    allocateRoute(): string {
        return newSessionId();
    }

    adopt(input: AgentAdoptInput): AgentIdentity {
        const agentName = normalizeAgentName(input.agentName);
        const identity: AgentIdentity = {
            sessionId: input.sessionId ?? newSessionId(),
            paneId: input.paneId,
            workspaceId: input.workspaceId,
            tabId: input.tabId,
            cwd: input.cwd,
            agentName,
            taskTitle: taskTitleFor(input.taskTitle, input.kind, agentName),
            createdAt: new Date().toISOString(),
            ours: input.ours,
            ...(input.kind === undefined ? {} : { kind: input.kind }),
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
        const known = live.previousPaneId === undefined
            ? this.byPane(live.paneId)
            : this.byPane(live.previousPaneId) ?? this.byPane(live.paneId);
        if (known !== undefined) {
            const displaced = this.displace(known, live.paneId);
            const identity = this.reconcile(known, live);
            if (displaced === undefined) return { identity, created: false, previousPaneId: known.paneId };
            return { identity, created: false, previousPaneId: known.paneId, displaced };
        }
        const kind = live.kind;
        const agentName = normalizeAgentName(live.agentName);
        const identity: AgentIdentity = {
            sessionId: newSessionId(),
            paneId: live.paneId,
            workspaceId: live.workspaceId ?? '',
            tabId: live.tabId ?? '',
            cwd: live.cwd ?? '/',
            agentName,
            taskTitle: this.observedTaskTitle(undefined, live, kind, agentName),
            createdAt: new Date().toISOString(),
            ours: false,
            ...(kind === undefined ? {} : { kind }),
        };
        this.byId.set(identity.sessionId, identity);
        this.persist();
        return { identity, created: true };
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
        const agentName = Object.hasOwn(live, 'agentName')
            ? normalizeAgentName(live.agentName)
            : known.agentName;
        const next: AgentIdentity = {
            sessionId: known.sessionId,
            paneId: live.paneId,
            workspaceId: live.workspaceId ?? known.workspaceId,
            tabId: live.tabId ?? known.tabId,
            cwd: live.cwd ?? known.cwd,
            agentName,
            taskTitle: this.observedTaskTitle(known, live, kind, agentName),
            createdAt: known.createdAt,
            ours: known.ours,
            ...(kind === undefined ? {} : { kind }),
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
        agentName: string,
    ): string {
        if (known !== undefined && known.ours && known.taskTitle !== genericTaskTitle(known.kind)) {
            return known.taskTitle;
        }
        const fromTerminal = parseTaskTitle(live.terminalTitle, kind, agentName);
        if (fromTerminal !== undefined) return fromTerminal;
        const fromPane = parseTaskTitle(live.paneLabel, kind, agentName);
        if (fromPane !== undefined) return fromPane;
        const fromTab = parseTaskTitle(live.tabLabel, kind, agentName);
        if (fromTab !== undefined) return fromTab;
        if (known !== undefined) return known.taskTitle;
        return genericTaskTitle(kind);
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
