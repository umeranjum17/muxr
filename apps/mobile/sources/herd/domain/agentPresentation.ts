import type { AgentLifecycle, HerdrTreePane } from '@muxr/contract';
import type { Session } from '@/catalog';
import { HERD_STATUS_LABELS } from './herd';

export interface AgentLabels {
    taskTitle: string;
    humanName?: string;
    providerKind?: string;
    context?: string;
}

/** One display vocabulary: Task Title, Human Name, then optional provider/context. */
export function agentLabels(pane?: HerdrTreePane, session?: Session): AgentLabels {
    const metadata = session?.metadata;
    return {
        taskTitle: pane?.taskTitle?.trim() || metadata?.taskTitle?.trim() || 'Untitled task',
        humanName: metadata?.displayName?.trim() || pane?.displayName?.trim() || undefined,
        providerKind: pane?.agentKind?.trim() || metadata?.agentKind?.trim() || metadata?.provider?.kind?.trim() || undefined,
        context: metadata?.worktree?.branch?.trim() || metadata?.workspaceLabel?.trim() || undefined,
    };
}

export function agentAccessibilityLabel(labels: AgentLabels, status: AgentLifecycle, sinceMs?: number): string {
    const elapsed = sinceMs === undefined ? undefined : compactAge(Date.now() - sinceMs);
    let age = '';
    if (elapsed === 'now') age = ' just now';
    else if (elapsed !== undefined) age = ` for ${elapsed}`;
    return [labels.taskTitle, `${HERD_STATUS_LABELS[status]}${age}`, labels.humanName]
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
