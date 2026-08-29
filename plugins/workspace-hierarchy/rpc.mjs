#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { closeAgent, createSocketCall } from './close.mjs';

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
    if (status === 'blocked') return 'danger';
    if (status === 'working') return 'warning';
    if (status === 'done') return 'positive';
    return 'secondary';
}

function runTree() {
    const sessionId = clean(input().sessionId, 80);
    const workspaces = context();
    const workspace = workspaces.find((candidate) =>
        Array.isArray(candidate?.tabs) && candidate.tabs.some((tab) =>
            Array.isArray(tab?.sessions) && tab.sessions.some((session) => session?.sessionId === sessionId),
        ),
    ) ?? workspaces[0];

    if (workspace === undefined || !Array.isArray(workspace.tabs)) {
        process.stdout.write(JSON.stringify({ title: 'Workspace', nodes: [] }));
        return;
    }

    const tabs = workspace.tabs;
    const baseNames = tabs.map((tab, index) => clean(tab?.label, 80) ?? `Tab ${index + 1}`);
    const duplicate = (name) => baseNames.filter((candidate) => candidate === name).length > 1;

    const nodes = tabs.map((tab, tabIndex) => {
        const sessions = Array.isArray(tab?.sessions) ? tab.sessions : [];
        const first = sessions[0];
        const shell = first === undefined;
        const base = baseNames[tabIndex];
        const title = duplicate(base) ? `${base} · tab ${tabIndex + 1}` : base;
        const labeled = shell ? `${title} · shell` : title;
        const children = sessions.flatMap((session, sessionIndex) => {
            const id = clean(session?.sessionId, 80);
            if (id === undefined) return [];
            const agentName = clean(session.agentName, 80) ?? 'Unnamed agent';
            const agentKind = clean(session.agentKind, 40) ?? 'Unknown provider';
            const displayAgent = clean(session.displayAgent, 80);
            return [{
                id: `session-${tabIndex + 1}-${sessionIndex + 1}`,
                title: clean(session.taskTitle, 120) ?? 'Untitled task',
                subtitle: [agentName, agentKind, displayAgent].filter(Boolean).join(' · '),
                icon: 'terminal-outline',
                status: tone(clean(session.agentStatus, 20)),
                action: { type: 'kernel.navigate', target: 'session', sessionId: id },
            }];
        });
        const firstId = clean(first?.sessionId, 80);
        return {
            id: `tab-${tabIndex + 1}`,
            title: labeled,
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
}

async function runClose() {
    const body = input();
    const paneId = clean(body.paneId, 80);
    if (paneId === undefined) {
        process.stderr.write('close requires a paneId\n');
        process.exitCode = 1;
        return;
    }
    const confirmedScope = body.confirmedScope;
    try {
        const result = await closeAgent({
            paneId,
            ...(confirmedScope === undefined ? {} : { confirmedScope }),
            call: createSocketCall(),
        });
        process.stdout.write(JSON.stringify(result));
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}

if (process.argv[2] === 'close') await runClose();
else runTree();
