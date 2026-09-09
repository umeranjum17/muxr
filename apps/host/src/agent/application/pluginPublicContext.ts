import {
    MAX_PLUGIN_CONTEXT_ATTENTION,
    MAX_PLUGIN_CONTEXT_BYTES,
    MAX_PLUGIN_CONTEXT_SESSIONS,
    MAX_PLUGIN_CONTEXT_TABS,
    MAX_PLUGIN_CONTEXT_TREE_SESSIONS,
    MAX_PLUGIN_CONTEXT_WORKSPACES,
    capUtf8Bytes,
    sanitizeDisplayText,
    type AgentLifecycle,
    type PluginContextRequest,
    type PluginPublicContext,
    type PluginPublicSessionContext,
} from '@muxr/contract';

export interface PublicContextSource {
    sessions: Array<{
        sessionId: string;
        label?: string | undefined;
        agentName?: string | undefined;
        taskTitle?: string | undefined;
        cwd?: string | undefined;
        workspaceLabel?: string | undefined;
        tabLabel?: string | undefined;
        agentKind?: string | undefined;
        displayAgent?: string | undefined;
        activeAt?: string | undefined;
        agentStatus?: string | undefined;
        promptable: boolean;
    }>;
    attention: Array<{ sessionId: string; reason: string; detail?: string | undefined; at: string }>;
    workspaces: Array<{
        label?: string | undefined;
        focused: boolean;
        agentStatus?: string | undefined;
        tabs: Array<{
            label?: string | undefined;
            focused: boolean;
            agentStatus?: string | undefined;
            sessions: Array<{ sessionId?: string | undefined; label?: string | undefined; agentName?: string | undefined; taskTitle?: string | undefined; agentKind?: string | undefined; displayAgent?: string | undefined; agentStatus?: string | undefined; promptable: boolean }>;
        }>;
    }>;
}

const LIFECYCLE = new Set<AgentLifecycle>(['starting', 'idle', 'working', 'blocked', 'done', 'failed', 'unknown']);
const ATTENTION_REASON = new Set(['waiting', 'blocked', 'failed', 'done']);

function text(value: string | undefined, max: number): string | undefined {
    if (value === undefined) return undefined;
    const clean = capUtf8Bytes(sanitizeDisplayText(value), max).replace(/[\0-\x1F\x7F]/g, '').trim();
    return clean === '' ? undefined : clean;
}

function iso(value: string | undefined, fallback = new Date(0).toISOString()): string {
    if (value === undefined) return fallback;
    const clean = text(value, 40);
    return clean !== undefined && Number.isFinite(Date.parse(clean)) ? new Date(clean).toISOString() : fallback;
}

function sessionId(value: string): string | undefined {
    return text(value, 80);
}

function lifecycle(value: string | undefined): AgentLifecycle {
    return LIFECYCLE.has(value as AgentLifecycle) ? value as AgentLifecycle : 'unknown';
}

/** Build and bound the only host snapshot a plugin RPC may request. */
export function buildPluginPublicContext(
    requests: readonly PluginContextRequest[],
    source: PublicContextSource,
    preferredSessionId?: string,
): PluginPublicContext {
    const wantsSessions = requests.includes('sessions');
    const wantsTree = requests.includes('workspace-tree');
    const sessionOrder = (sessionId: string) => sessionId === preferredSessionId ? 0 : 1;
    let sessions = source.sessions
        .flatMap((session) => {
            const id = sessionId(session.sessionId);
            return id === undefined ? [] : [{ ...session, sessionId: id }];
        })
        .map((session): PluginPublicSessionContext => {
            const cwd = text(session.cwd, 256);
            const workspaceLabel = text(session.workspaceLabel, 80);
            const tabLabel = text(session.tabLabel, 80);
            const agentKind = text(session.agentKind, 40);
            const displayAgent = text(session.displayAgent, 80);
            const agentName = text(session.agentName, 80);
            const taskTitle = text(session.taskTitle, 120);
            return {
                sessionId: session.sessionId,
                label: text(session.label, 80) ?? 'session',
                ...(agentName === undefined ? {} : { agentName }),
                ...(taskTitle === undefined ? {} : { taskTitle }),
                ...(cwd === undefined ? {} : { cwd }),
                ...(workspaceLabel === undefined ? {} : { workspaceLabel }),
                ...(tabLabel === undefined ? {} : { tabLabel }),
                ...(agentKind === undefined ? {} : { agentKind }),
                ...(displayAgent === undefined ? {} : { displayAgent }),
                agentStatus: lifecycle(session.agentStatus),
                promptable: session.promptable === true,
                activeAt: iso(session.activeAt),
            };
        })
        .sort((a, b) => sessionOrder(a.sessionId) - sessionOrder(b.sessionId))
        .slice(0, MAX_PLUGIN_CONTEXT_SESSIONS);
    let attention = source.attention
        .flatMap((entry) => {
            const id = sessionId(entry.sessionId);
            return id !== undefined && ATTENTION_REASON.has(entry.reason) ? [{ ...entry, sessionId: id }] : [];
        })
        .map((entry) => ({
            sessionId: entry.sessionId,
            reason: entry.reason as 'waiting' | 'blocked' | 'failed' | 'done',
            detail: text(entry.detail, 160) ?? 'needs attention',
            at: iso(entry.at),
        }))
        .slice(0, MAX_PLUGIN_CONTEXT_ATTENTION);
    let workspaces = source.workspaces
        .map((workspace) => ({
            label: text(workspace.label, 80) ?? 'workspace',
            focused: workspace.focused === true,
            agentStatus: lifecycle(workspace.agentStatus),
            tabs: [...workspace.tabs].sort((a, b) => {
                const hasPreferred = (tab: typeof a) => preferredSessionId !== undefined && tab.sessions.some((session) => session.sessionId === preferredSessionId);
                return Number(hasPreferred(b)) - Number(hasPreferred(a));
            }).slice(0, MAX_PLUGIN_CONTEXT_TABS).map((tab) => ({
                label: text(tab.label, 80) ?? 'tab',
                focused: tab.focused === true,
                agentStatus: lifecycle(tab.agentStatus),
                sessions: [...tab.sessions].sort((a, b) => {
                    const preferred = (session: typeof a) => session.sessionId === preferredSessionId;
                    return Number(preferred(b)) - Number(preferred(a));
                }).slice(0, MAX_PLUGIN_CONTEXT_TREE_SESSIONS).flatMap((session) => {
                    const id = session.sessionId === undefined ? undefined : sessionId(session.sessionId);
                    if (session.sessionId !== undefined && id === undefined) return [];
                    const agentKind = text(session.agentKind, 40);
                    const displayAgent = text(session.displayAgent, 80);
                    const agentName = text(session.agentName, 80);
                    const taskTitle = text(session.taskTitle, 120);
                    return [{
                        ...(id === undefined ? {} : { sessionId: id }),
                        label: text(session.label, 80) ?? 'session',
                        ...(agentName === undefined ? {} : { agentName }),
                        ...(taskTitle === undefined ? {} : { taskTitle }),
                        ...(agentKind === undefined ? {} : { agentKind }),
                        ...(displayAgent === undefined ? {} : { displayAgent }),
                        agentStatus: lifecycle(session.agentStatus),
                        promptable: session.promptable === true,
                    }];
                }),
            })),
        }))
        .sort((a, b) => {
            const hasPreferred = (workspace: typeof a) => preferredSessionId !== undefined
                && workspace.tabs.some((tab) => tab.sessions.some((session) => session.sessionId === preferredSessionId));
            return Number(hasPreferred(b)) - Number(hasPreferred(a));
        })
        .slice(0, MAX_PLUGIN_CONTEXT_WORKSPACES);

    const context = (): PluginPublicContext => ({
        schemaVersion: 1,
        ...(wantsSessions ? { sessions, attention } : {}),
        ...(wantsTree ? { workspaces } : {}),
    });
    while (Buffer.byteLength(JSON.stringify(context()), 'utf8') > MAX_PLUGIN_CONTEXT_BYTES) {
        if (sessions.length > 1) sessions = sessions.slice(0, Math.ceil(sessions.length / 2));
        else if (attention.length > 1) attention = attention.slice(0, Math.ceil(attention.length / 2));
        else if (workspaces.length > 1) workspaces = workspaces.slice(0, Math.ceil(workspaces.length / 2));
        else if (workspaces.some((workspace) => workspace.tabs.length > 1)) {
            workspaces = workspaces.map((workspace) => ({ ...workspace, tabs: workspace.tabs.slice(0, Math.ceil(workspace.tabs.length / 2)) }));
        } else if (workspaces.some((workspace) => workspace.tabs.some((tab) => tab.sessions.length > 1))) {
            workspaces = workspaces.map((workspace) => ({
                ...workspace,
                tabs: workspace.tabs.map((tab) => ({ ...tab, sessions: tab.sessions.slice(0, Math.ceil(tab.sessions.length / 2)) })),
            }));
        } else {
            throw new Error('plugin public context is too large');
        }
    }
    return context();
}
