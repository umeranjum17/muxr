import { randomBytes } from 'node:crypto';
import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteJson } from '../../platform/atomicWriteJson.js';

export interface HerdrAgentSessionRef {
    source: string;
    agent: string;
    kind: 'id' | 'path';
    value: string;
}

export interface AgentRouteBinding {
    route: string;
    agentSession: HerdrAgentSessionRef;
}

interface RouteFile {
    version: 1;
    bindings: AgentRouteBinding[];
}

const ROUTE = /^pp_[a-f0-9]{32}$/;

export function parseHerdrAgentSession(value: unknown): HerdrAgentSessionRef | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const row = value as Record<string, unknown>;
    if (typeof row.source !== 'string' || row.source === '' || row.source.length > 256) return undefined;
    if (typeof row.agent !== 'string' || row.agent === '' || row.agent.length > 64) return undefined;
    if (row.kind !== 'id' && row.kind !== 'path') return undefined;
    if (typeof row.value !== 'string' || row.value === '' || row.value.length > 8_192) return undefined;
    return { source: row.source, agent: row.agent, kind: row.kind, value: row.value };
}

export function herdrAgentSessionKey(value: HerdrAgentSessionRef): string {
    return JSON.stringify([value.source, value.agent, value.kind, value.value]);
}

export const MUXR_LAUNCH_SOURCE = 'muxr:launch';

export function muxrLaunchSession(agent: string, launchName: string): HerdrAgentSessionRef {
    return { source: MUXR_LAUNCH_SOURCE, agent, kind: 'id', value: launchName };
}

export function isMuxrLaunchSession(ref: HerdrAgentSessionRef): boolean {
    return ref.source === MUXR_LAUNCH_SOURCE && ref.kind === 'id' && ref.value.length > 0;
}

/** Only adopt when Herdr published the same kind the launch asked for. */
export function shouldAdoptPublishedLaunch(pending: HerdrAgentSessionRef, published: HerdrAgentSessionRef): boolean {
    return isMuxrLaunchSession(pending) && !isMuxrLaunchSession(published) && pending.agent === published.agent;
}

/** Durable authorization only. Display identity and topology always come from Herdr. */
export class AgentRouteStore {
    private readonly byRoute = new Map<string, AgentRouteBinding>();
    private readonly routeBySession = new Map<string, string>();
    private readonly file: string;
    private writes: Promise<void> = Promise.resolve();
    private writeError: unknown;

    constructor(dataDir: string) {
        this.file = join(dataDir, 'herdr-routes.json');
    }

    async load(): Promise<void> {
        this.byRoute.clear();
        this.routeBySession.clear();
        try {
            const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'));
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
                || !('version' in parsed) || parsed.version !== 1
                || !('bindings' in parsed) || !Array.isArray(parsed.bindings)) return;
            for (const candidate of parsed.bindings) {
                if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)
                    || !('route' in candidate) || typeof candidate.route !== 'string'
                    || !('agentSession' in candidate)) continue;
                const agentSession = parseHerdrAgentSession(candidate.agentSession);
                if (!ROUTE.test(candidate.route) || agentSession === undefined) continue;
                const key = herdrAgentSessionKey(agentSession);
                if (this.byRoute.has(candidate.route) || this.routeBySession.has(key)) continue;
                const binding = { route: candidate.route, agentSession };
                this.byRoute.set(binding.route, binding);
                this.routeBySession.set(key, binding.route);
            }
            await chmod(this.file, 0o600);
        } catch {
            // Missing, corrupt, or obsolete state rebuilds from current Herdr sessions.
        }
    }

    get(route: string): HerdrAgentSessionRef | undefined {
        return this.byRoute.get(route)?.agentSession;
    }

    route(agentSession: HerdrAgentSessionRef): string | undefined {
        return this.routeBySession.get(herdrAgentSessionKey(agentSession));
    }

    bind(agentSession: HerdrAgentSessionRef): { route: string; created: boolean } {
        const known = this.route(agentSession);
        if (known !== undefined) return { route: known, created: false };
        let route: string;
        do route = `pp_${randomBytes(16).toString('hex')}`;
        while (this.byRoute.has(route));
        const binding = { route, agentSession };
        this.byRoute.set(route, binding);
        this.routeBySession.set(herdrAgentSessionKey(agentSession), route);
        this.persist();
        return { route, created: true };
    }

    /** Keep the phone's route when a launch generation later publishes its Herdr session. */
    adopt(from: HerdrAgentSessionRef, to: HerdrAgentSessionRef): { route: string } | undefined {
        const toRoute = this.route(to);
        const fromRoute = this.route(from);
        if (toRoute !== undefined) {
            if (fromRoute !== undefined && fromRoute !== toRoute) this.remove(fromRoute);
            return { route: toRoute };
        }
        if (fromRoute === undefined) return undefined;
        this.routeBySession.delete(herdrAgentSessionKey(from));
        const binding = { route: fromRoute, agentSession: to };
        this.byRoute.set(fromRoute, binding);
        this.routeBySession.set(herdrAgentSessionKey(to), fromRoute);
        this.persist();
        return { route: fromRoute };
    }

    remove(route: string): AgentRouteBinding | undefined {
        const binding = this.byRoute.get(route);
        if (binding === undefined) return undefined;
        this.byRoute.delete(route);
        this.routeBySession.delete(herdrAgentSessionKey(binding.agentSession));
        this.persist();
        return binding;
    }

    reconcile(liveSessions: readonly HerdrAgentSessionRef[]): AgentRouteBinding[] {
        const live = new Set(liveSessions.map(herdrAgentSessionKey));
        const removed: AgentRouteBinding[] = [];
        for (const binding of this.byRoute.values()) {
            if (live.has(herdrAgentSessionKey(binding.agentSession))) continue;
            this.byRoute.delete(binding.route);
            this.routeBySession.delete(herdrAgentSessionKey(binding.agentSession));
            removed.push(binding);
        }
        if (removed.length > 0) this.persist();
        return removed;
    }

    all(): AgentRouteBinding[] {
        return [...this.byRoute.values()];
    }

    async flush(): Promise<void> {
        await this.writes;
        if (this.writeError !== undefined) throw this.writeError;
    }

    private persist(): void {
        const snapshot: RouteFile = { version: 1, bindings: this.all() };
        this.writes = this.writes.then(async () => {
            try {
                await atomicWriteJson(this.file, snapshot);
                this.writeError = undefined;
            } catch (error) {
                this.writeError = error;
            }
        });
    }
}
