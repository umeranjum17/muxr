#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const serializedInput = readFileSync(0, 'utf8');

function clean(value, max = 160) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : undefined;
}

function input() {
    try { return JSON.parse(serializedInput || '{}') ?? {}; }
    catch { return {}; }
}

function context() {
    try {
        const parsed = JSON.parse(process.env.MUXR_PLUGIN_CONTEXT_JSON ?? '{}');
        return Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
    } catch {
        return [];
    }
}

function tone(status) {
    return status === 'blocked' ? 'danger'
        : status === 'working' ? 'warning'
        : status === 'done' ? 'positive'
        : 'secondary';
}

const sessionId = clean(input().sessionId, 80);
const workspaces = context();
const workspace = workspaces.find((candidate) =>
    Array.isArray(candidate?.tabs) && candidate.tabs.some((tab) =>
        Array.isArray(tab?.sessions) && tab.sessions.some((session) => session?.sessionId === sessionId),
    ),
) ?? workspaces[0];

if (workspace === undefined || !Array.isArray(workspace.tabs)) {
    process.stdout.write(JSON.stringify({ title: 'Workspace', nodes: [] }));
    process.exit(0);
}

const tabs = workspace.tabs;
const baseNames = tabs.map((tab) => {
    const first = Array.isArray(tab?.sessions) ? tab.sessions[0] : undefined;
    return clean(first?.label, 80) ?? clean(tab?.label, 80) ?? 'tab';
});
const duplicate = (name) => baseNames.filter((candidate) => candidate === name).length > 1;

const nodes = tabs.map((tab, tabIndex) => {
    const sessions = Array.isArray(tab?.sessions) ? tab.sessions : [];
    const first = sessions[0];
    const shell = first === undefined;
    const base = baseNames[tabIndex];
    const title = `${duplicate(base) ? `${base} · tab ${tabIndex + 1}` : base}${shell ? ' · shell' : ''}`;
    const children = sessions.flatMap((session, sessionIndex) => {
        const id = clean(session?.sessionId, 80);
        if (id === undefined) return [];
        return [{
            id: `session-${tabIndex + 1}-${sessionIndex + 1}`,
            title: clean(session.label, 80) ?? clean(session.agentKind, 40) ?? 'session',
            subtitle: clean(session.agentKind, 40),
            icon: 'terminal-outline',
            status: tone(clean(session.agentStatus, 20)),
            pulsing: session.agentStatus === 'working' || session.agentStatus === 'blocked',
            current: id === sessionId,
            action: { type: 'kernel.navigate', target: 'session', sessionId: id },
        }];
    });
    const firstId = clean(first?.sessionId, 80);
    return {
        id: `tab-${tabIndex + 1}`,
        title,
        status: tone(clean(tab?.agentStatus, 20)),
        pulsing: tab?.agentStatus === 'working' || tab?.agentStatus === 'blocked',
        current: sessions.some((session) => session?.sessionId === sessionId),
        ...(firstId === undefined ? {} : { action: { type: 'kernel.navigate', target: 'session', sessionId: firstId } }),
        ...(children.length === 0 ? {} : { children }),
    };
});

const workspaceTitle = clean(workspace.label, 80)?.split('/').filter(Boolean).pop() ?? clean(workspace.label, 80) ?? 'Workspace';
process.stdout.write(JSON.stringify({
    title: workspaceTitle,
    nodes,
}));
