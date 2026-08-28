/**
 * Agent identity. One current schema: Human Name, Task Title, Provider Kind,
 * and an Agent Route. Herdr pane ids move; the route does not. Old or invalid
 * files are ignored and the map rebuilds from live Herdr.
 */

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { atomicWriteJson } from '../domain/atomicWriteJson.js';
import { join } from 'node:path';

const SCHEMA_VERSION = 4 as const;
const HUMAN_NAME = /^[\p{L}\p{M}][\p{L}\p{M}' -]{0,72}(?: \d+)?$/u;
const POOL = [
    'John', 'Maria', 'Alex', 'Maya', 'Sam',
    'Nina', 'Leo', 'Sara', 'Omar', 'Lina',
    'Noah', 'Zoe', 'Adam', 'Emma', 'Ryan',
    'Iris', 'Luke', 'Anna', 'Eli', 'Mila',
];
const PROVIDER_KINDS = new Set([
    'pi', 'claude', 'codex', 'opencode', 'gemini', 'grok', 'cursor', 'amp', 'copilot',
    'droid', 'kimi', 'kilo', 'devin', 'hermes', 'omp', 'cline', 'kiro', 'maki',
    'mastracode', 'qodercli', 'agy', 'shell',
]);
const GREETING = /^(hi|hey|hello|yo|sup|test|ok|hmm|thanks|help)(\s|$)/i;
const FIRST_PROMPT = /^[a-z0-9]+(?:\s+[a-z0-9]+){2,5}$/;

export interface AgentIdentity {
    /** Agent Route. Stable across pane moves; the only routing key. */
    sessionId: string;
    paneId: string;
    workspaceId: string;
    tabId: string;
    cwd: string;
    /** Human Name. Secondary, spoken, never a routing key. */
    displayName: string;
    /** Task Title. Primary work identity, never a routing key. */
    taskTitle: string;
    /** Provider Kind. Which coding agent, never a name. */
    kind?: string | undefined;
    agentName?: string | undefined;
    createdAt: string;
    ours: boolean;
}

export interface AgentObservation {
    paneId: string;
    previousPaneId?: string | undefined;
    workspaceId?: string | undefined;
    tabId?: string | undefined;
    cwd?: string | undefined;
    agentName?: string | undefined;
    kind?: string | undefined;
    paneLabel?: string | undefined;
    tabLabel?: string | undefined;
    terminalTitle?: string | undefined;
}

export interface AgentAdoptInput {
    sessionId?: string;
    paneId: string;
    workspaceId: string;
    tabId: string;
    cwd: string;
    displayName: string;
    taskTitle?: string | undefined;
    kind?: string | undefined;
    agentName?: string | undefined;
    ours: boolean;
}

export interface NameReservation {
    sessionId: string;
    displayName: string;
    release(): void;
}

interface IdentityFile {
    schemaVersion: typeof SCHEMA_VERSION;
    sessions: AgentIdentity[];
}

function namedError(message: string, code: string): Error & { code: string } {
    const error = new Error(message) as Error & { code: string };
    error.code = code;
    return error;
}

function normalizeHuman(value: string): string {
    return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function humanKey(value: string): string {
    return normalizeHuman(value).toLocaleLowerCase('und').replace(/ß/g, 'ss').replace(/ς/g, 'σ');
}

function newSessionId(): string {
    return `pp_${randomBytes(4).toString('hex')}`;
}

function genericTaskTitle(kind?: string): string {
    const cleanKind = kind?.normalize('NFKC').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
    if (cleanKind === undefined || cleanKind === '') return 'Coding task';
    return `${cleanKind.charAt(0).toLocaleUpperCase()}${cleanKind.slice(1)} task`;
}

/** Task Title from live chrome. Rejects provider kinds, handles, greetings, and paths. */
export function parseTaskTitle(value: string | undefined, kind?: string, humanName?: string): string | undefined {
    let clean = value?.replace(/^[◐◑◒◓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*/, '').replace(/[\0-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (clean === undefined || clean === '') return undefined;
    for (const prefix of [kind, humanName]) {
        if (prefix === undefined || prefix.trim() === '') continue;
        const escaped = prefix.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        clean = clean.replace(new RegExp(`^${escaped}\\s*[-–—:|]\\s*`, 'i'), '').trim();
    }
    const lower = clean.toLocaleLowerCase();
    if (clean === '' || lower === kind?.toLocaleLowerCase()) return undefined;
    if (/^pp_|^pph_/i.test(clean) || /^\d+$/.test(clean) || PROVIDER_KINDS.has(lower)) return undefined;
    if (GREETING.test(clean) || FIRST_PROMPT.test(clean)) return undefined;
    if (/^(?:\/|[A-Za-z]:\\|[$>#]|(?:cd|pwd|ls|git|npm|npx|yarn|pnpm|node|python|bash|zsh|fish)\b)|[\\/`]|&&|\|\||\b(?:token|password|secret|credential)\s*=/i.test(clean)) return undefined;
    if (clean.split(/\s+/).length > 8) return undefined;
    return clean;
}

/** Always a Task Title: accepted chrome, else a generic title from Provider Kind. */
export function taskTitleFor(value?: string, kind?: string, humanName?: string): string {
    const parsed = parseTaskTitle(value, kind, humanName);
    if (parsed !== undefined) return parsed;
    return genericTaskTitle(kind);
}

function parseAgent(value: unknown): AgentIdentity | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const row = value as Record<string, unknown>;
    if (typeof row.sessionId !== 'string' || row.sessionId.trim() === '') return undefined;
    if (typeof row.paneId !== 'string' || row.paneId.trim() === '') return undefined;
    if (typeof row.workspaceId !== 'string' || typeof row.tabId !== 'string') return undefined;
    if (typeof row.cwd !== 'string' || row.cwd.trim() === '') return undefined;
    if (typeof row.createdAt !== 'string' || typeof row.ours !== 'boolean') return undefined;
    if (typeof row.displayName !== 'string' || typeof row.taskTitle !== 'string') return undefined;
    const displayName = normalizeHuman(row.displayName);
    const taskTitle = row.taskTitle.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!HUMAN_NAME.test(displayName) || taskTitle === '') return undefined;
    const kind = typeof row.kind === 'string' && row.kind.trim() !== '' ? row.kind : undefined;
    const agentName = typeof row.agentName === 'string' && row.agentName.trim() !== '' ? row.agentName : undefined;
    return {
        sessionId: row.sessionId,
        paneId: row.paneId,
        workspaceId: row.workspaceId,
        tabId: row.tabId,
        cwd: row.cwd,
        displayName,
        taskTitle,
        createdAt: row.createdAt,
        ours: row.ours,
        ...(kind === undefined ? {} : { kind }),
        ...(agentName === undefined ? {} : { agentName }),
    };
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
                const agent = parseAgent(session);
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
            if (!HUMAN_NAME.test(clean)) throw namedError('Choose a short human name, such as John or Maria.', 'invalid-display-name');
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
