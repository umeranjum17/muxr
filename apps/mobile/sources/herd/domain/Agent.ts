import type { AgentLifecycle } from '@muxr/contract';

/**
 * The terminal-shaped card in the Herd. Agent Route authorizes; Agent Name and
 * Task Title are display-only and never used as keys.
 */
export type AgentRecord = {
    route: string;
    agentName: string;
    taskTitle: string;
    recordedStatus?: AgentLifecycle;
    online: boolean;
    thinking: boolean;
    permissionRequestCount: number;
    doing?: string;
};

export class Agent {
    constructor(readonly record: AgentRecord) {}

    get route(): string {
        return this.record.route;
    }

    /** Stable spoken Agent Name. Never a routing key. */
    get agentName(): string {
        return this.record.agentName.trim() || 'Agent';
    }

    get taskTitle(): string {
        return this.record.taskTitle.trim() || 'Current task';
    }

    sameAs(other: Agent): boolean {
        return this.route === other.route;
    }

    needsYou(): boolean {
        return this.lifecycle() === 'blocked';
    }

    isWorking(): boolean {
        const status = this.lifecycle();
        return status === 'working' || status === 'starting';
    }

    isSettled(): boolean {
        const status = this.lifecycle();
        return status === 'done' || status === 'idle';
    }

    /**
     * Live streaming beats a stale lifecycle word: hosts that predate
     * agentStatus inside status.update only move isStreaming (thinking).
     */
    lifecycle(): AgentLifecycle {
        const raw = this.record.recordedStatus;
        if (raw === 'blocked' || raw === 'failed' || raw === 'starting') return raw;
        if (raw === 'idle' || raw === 'working' || raw === 'done') {
            if (raw !== 'working' && this.record.online && this.record.thinking) return 'working';
            return raw;
        }
        if (!this.record.online) return 'unknown';
        if (this.record.permissionRequestCount > 0) return 'blocked';
        return this.record.thinking ? 'working' : 'done';
    }
}
