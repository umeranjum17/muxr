import type { RequestResult } from '@trymuxr/contract';
import { agentToolPath, type SessionSource } from '../../agent/index.js';
import { delimiter } from 'node:path';
import { claudeIdentity, codexIdentity, defaultPlanFolder } from '../../plans/index.js';

type Catalog = RequestResult<'herdr.agentKinds'>;
const CACHE_MS = 30_000;

/** One host-owned cache shared by every picker and connected device.
 * Default-folder identity checks contribute only sign-in state: email and
 * plan details must never enter this catalog. Unsupported or unavailable
 * checks remain unknown. Explicit refresh waits for pending work, then checks
 * again so a pre-sign-in collection cannot answer Check again. */
export class AgentCatalog {
    private cached: Catalog | undefined;
    private checkedAt = 0;
    private pending: Promise<Catalog> | undefined;

    constructor(
        private readonly source: Pick<SessionSource, 'agentKinds' | 'installedAgentKinds'>,
        private readonly env: NodeJS.ProcessEnv = process.env,
    ) {}

    async read(refresh = false): Promise<Catalog> {
        if (this.pending !== undefined) {
            if (!refresh) return this.pending;
            await this.pending.catch(() => undefined);
            return this.read(true);
        }
        if (!refresh && this.cached !== undefined && Date.now() - this.checkedAt < CACHE_MS) return this.cached;
        this.pending = this.collect();
        try {
            const result = await this.pending;
            this.cached = result;
            this.checkedAt = Date.now();
            return result;
        } finally {
            this.pending = undefined;
        }
    }

    /** Connect never waits for the bounded provider checks. A failed catalog
     * lookup is retried by the next request rather than retaining stale state. */
    refresh(): void {
        this.checkedAt = 0;
        void this.read().catch(() => { this.cached = undefined; });
    }

    private async collect(): Promise<Catalog> {
        const kinds = await this.source.agentKinds();
        const installed = await this.source.installedAgentKinds(kinds);
        const env = { ...this.env, PATH: agentToolPath(this.env).join(delimiter) };
        const readiness: NonNullable<Catalog['readiness']> = {};
        await Promise.all(kinds.map(async (kind) => {
            const state: NonNullable<Catalog['readiness']>[string] = { signedIn: 'unknown' };
            readiness[kind] = state;
            if (!installed.includes(kind)) {
                state.installHint = kind === 'pi'
                    ? 'Installs on first start'
                    : `Install ${kind} on this computer, then check again.`;
                return;
            }
            if (kind !== 'claude' && kind !== 'codex') return;
            const identity = kind === 'claude' ? claudeIdentity : codexIdentity;
            const result = await identity(defaultPlanFolder(kind, env), env);
            if (result.statusKnown === false) return;
            state.signedIn = result.signedIn ? 'yes' : 'no';
            if (!result.signedIn) state.signInHint = `On your computer run \`${kind}\`, sign in, then check again.`;
        }));
        return { kinds, installed, readiness };
    }
}
