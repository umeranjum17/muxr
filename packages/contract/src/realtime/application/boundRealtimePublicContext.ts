import { parseHumanName, parseProviderKind, parsePublicAgentRoute } from '../../herd/index.js';
import {
    MAX_REALTIME_PUBLIC_SESSIONS,
    type RealtimePluginPublicContext,
    type RealtimePluginPublicSession,
} from '../domain/realtimeStream.js';

function publicTaskTitle(raw: string | undefined, displayName: string, providerKind: string | undefined): string | undefined {
    let taskTitle = raw?.replace(/[\0-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (taskTitle === undefined) return undefined;
    for (const prefix of [displayName, providerKind]) {
        if (prefix === undefined || prefix === '') continue;
        const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        taskTitle = taskTitle.replace(new RegExp(`^${escaped}\\s*[-–—:|]\\s*`, 'i'), '').trim();
    }
    const looksLikeASecret = /[\\/`]|&&|\|\||\b(?:token|password|secret|credential)\s*=/i.test(taskTitle);
    if (taskTitle === '' || taskTitle.split(/\s+/).length > 8 || looksLikeASecret) return undefined;
    return taskTitle;
}

/** Bound the public Agent map before it crosses a stream process. Agent Route authorizes; Human Name never does. */
export function boundRealtimePublicContext(command: {
    sessions: readonly RealtimePluginPublicSession[];
}): RealtimePluginPublicContext {
    const sessions: RealtimePluginPublicSession[] = [];
    const ids = new Set<string>();
    for (const entry of command.sessions) {
        const sessionId = parsePublicAgentRoute(entry.sessionId);
        const displayName = parseHumanName(entry.displayName);
        if (!sessionId.ok || ids.has(sessionId.value) || !displayName.ok) continue;
        const providerKind = entry.agentKind === undefined ? undefined : parseProviderKind(entry.agentKind);
        const taskTitle = publicTaskTitle(entry.taskTitle, displayName.value, providerKind?.ok ? providerKind.value : undefined);
        ids.add(sessionId.value);
        sessions.push({
            sessionId: sessionId.value,
            displayName: displayName.value,
            ...(taskTitle === undefined ? {} : { taskTitle }),
            ...(providerKind === undefined || !providerKind.ok ? {} : { agentKind: providerKind.value }),
        });
        if (sessions.length === MAX_REALTIME_PUBLIC_SESSIONS) break;
    }
    return { sessions };
}

export function realtimePluginPublicContext(input: readonly RealtimePluginPublicSession[]): RealtimePluginPublicContext {
    return boundRealtimePublicContext({ sessions: input });
}
