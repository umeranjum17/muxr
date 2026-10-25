import type { AgentLifecycle } from '@trymuxr/contract';
import type { TranslationKey } from '@/text';
import { t } from '@/text';

/** What the herd is doing, as one plain answer for the top of Home. Four states
 *  a person can act on, plus the empty machine. */
export type AgentSummary = 'waiting' | 'stopped' | 'working' | 'ready' | 'none';

/** Most urgent first: one agent waiting on an answer outranks a stopped one,
 *  which outranks the work that can carry on without the reader. */
const BY_URGENCY: readonly AgentSummary[] = ['waiting', 'stopped', 'working', 'ready'];

function agentState(agent: { agentStatus: AgentLifecycle; pendingRequest?: boolean }): AgentSummary {
    if (agent.pendingRequest === true || agent.agentStatus === 'blocked') return 'waiting';
    if (agent.agentStatus === 'failed' || agent.agentStatus === 'unknown') return 'stopped';
    if (agent.agentStatus === 'working' || agent.agentStatus === 'starting') return 'working';
    return 'ready';
}

/** The one thing worth saying about a whole herd. */
export function agentSummary(agents: readonly { agentStatus: AgentLifecycle; pendingRequest?: boolean }[]): AgentSummary {
    const states = new Set(agents.map(agentState));
    return BY_URGENCY.find((state) => states.has(state)) ?? 'none';
}

const LINES: Record<AgentSummary, TranslationKey> = {
    waiting: 'plugins.rightNow.herdWaiting',
    stopped: 'plugins.rightNow.herdStopped',
    working: 'plugins.rightNow.herdWorking',
    ready: 'plugins.rightNow.herdReady',
    none: 'plugins.rightNow.herdNone',
};

/** What that state says to the person: what is happening, and the step they can take. */
export function agentSummaryLine(summary: AgentSummary): string {
    return t(LINES[summary]);
}
