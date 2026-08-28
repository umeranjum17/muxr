import type { AgentLifecycle, HerdrTreePane } from '@muxr/contract';
import type { Session } from '@/catalog';
import { HERD_STATUS_LABELS } from './herd';
import { paneDisplayName } from './herdTree';

export interface AgentLabels {
    taskTitle: string;
    agentName?: string;
}

/** One display vocabulary: Task Title, then canonical speakable Agent Name. */
export function agentLabels(pane?: HerdrTreePane, session?: Session): AgentLabels {
    const metadata = session?.metadata;
    return {
        taskTitle: pane?.taskTitle?.trim() || metadata?.taskTitle?.trim() || 'Untitled task',
        agentName: metadata?.agentName?.trim() || (pane === undefined ? undefined : paneDisplayName(pane)),
    };
}

export function agentStateLabel(status: AgentLifecycle, changedAt?: number, now = Date.now()): string {
    const label = HERD_STATUS_LABELS[status];
    if (status === 'working' || status === 'starting' || changedAt === undefined) return label;
    return `${label} · ${compactAge(now - changedAt)}`;
}

export function agentAccessibilityLabel(labels: AgentLabels, status: AgentLifecycle, changedAt?: number): string {
    const state = changedAt === undefined ? HERD_STATUS_LABELS[status] : agentStateLabel(status, changedAt);
    return [labels.taskTitle, state, labels.agentName]
        .filter((value): value is string => value !== undefined && value !== '')
        .join('. ');
}

export function compactAge(elapsedMs: number): string {
    const minutes = Math.max(0, Math.floor(elapsedMs / 60_000));
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}
