import { parseAgentLifecycle, parseAgentName, parseProviderKind, parsePublicAgentRoute } from '../../herd/index.js';
import {
    MAX_REALTIME_PUBLIC_SESSIONS,
    type RealtimePluginPublicContext,
    type RealtimePluginPublicSession,
} from '../domain/realtimeStream.js';

function publicOptionalText(value: unknown, max: number): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value === '' || value.length > max || /[\0-\x1F\x7F]/.test(value)) return undefined;
    if (/[\\/`]|&&|\|\||\b(?:token|password|secret|credential)\s*=/i.test(value)) return undefined;
    return value;
}

function publicTaskTitle(
    raw: string | undefined,
    agentName: string | undefined,
    providerKind: string | undefined,
): string | undefined {
    let taskTitle = raw?.replace(/[\0-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (taskTitle === undefined) return undefined;
    for (const prefix of [agentName, providerKind]) {
        if (prefix === undefined || prefix === '') continue;
        const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        taskTitle = taskTitle.replace(new RegExp(`^${escaped}\\s*[-–—:|]\\s*`, 'i'), '').trim();
    }
    const looksLikeASecret = /[\\/`]|&&|\|\||\b(?:token|password|secret|credential)\s*=/i.test(taskTitle);
    if (taskTitle === '' || taskTitle.split(/\s+/).length > 8 || looksLikeASecret) return undefined;
    return taskTitle;
}

/** Validate the one-to-one AgentInfo projection before it crosses a stream process. */
export function boundRealtimePublicContext(command: {
    sessions: readonly RealtimePluginPublicSession[];
}): RealtimePluginPublicContext {
    const sessions: RealtimePluginPublicSession[] = [];
    const ids = new Set<string>();
    for (const entry of command.sessions) {
        const sessionId = parsePublicAgentRoute(entry.sessionId);
        const agentStatus = parseAgentLifecycle(entry.agentStatus);
        if (!sessionId.ok || ids.has(sessionId.value) || !agentStatus.ok || typeof entry.promptable !== 'boolean') continue;
        const parsedAgentName = entry.agentName === undefined ? undefined : parseAgentName(entry.agentName);
        const parsedAgentKind = entry.agentKind === undefined ? undefined : parseProviderKind(entry.agentKind);
        const agentName = parsedAgentName?.ok ? parsedAgentName.value : undefined;
        const agentKind = parsedAgentKind?.ok ? parsedAgentKind.value : undefined;
        const taskTitle = publicTaskTitle(entry.taskTitle, agentName, agentKind);
        const displayAgent = publicOptionalText(entry.displayAgent, 80);
        ids.add(sessionId.value);
        sessions.push({
            sessionId: sessionId.value,
            ...(agentName === undefined ? {} : { agentName }),
            ...(taskTitle === undefined ? {} : { taskTitle }),
            ...(agentKind === undefined ? {} : { agentKind }),
            ...(displayAgent === undefined ? {} : { displayAgent }),
            agentStatus: agentStatus.value,
            promptable: entry.promptable,
        });
        if (sessions.length === MAX_REALTIME_PUBLIC_SESSIONS) break;
    }
    return { sessions };
}

export function realtimePluginPublicContext(input: readonly RealtimePluginPublicSession[]): RealtimePluginPublicContext {
    return boundRealtimePublicContext({ sessions: input });
}
