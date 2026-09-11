import { connect } from 'node:net';

const GONE = new Set(['pane_not_found', 'tab_not_found', 'workspace_not_found']);
const CLOSE_SCOPES = ['pane', 'tab', 'workspace', 'worktreeGroup'];

export function herdrErrorCode(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /herdr: ([a-z0-9_]+):/i.exec(message)?.[1];
}

export function isGoneHerdr(error) {
    const code = herdrErrorCode(error);
    if (code !== undefined && GONE.has(code)) return true;
    const message = error instanceof Error ? error.message : String(error);
    return /no longer available|not found/i.test(message);
}

export function isRetryableHerdr(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /timed out|EACCES|ECONNREFUSED|ECONNRESET|ENOENT|ETIMEDOUT|server_not_running|connection closed|client closed|not running|EPIPE|connect E/i.test(message);
}

export function isNoWidenHerdr(error) {
    const message = error instanceof Error ? error.message : String(error);
    return herdrErrorCode(error) === 'confirmation_required' || /would (?:also )?close|confirmation required/i.test(message);
}

function labelOf(value, fallback) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function worktreeGroup(workspaces, workspace) {
    const worktree = workspace?.worktree;
    if (worktree?.is_linked_worktree !== false || typeof worktree?.repo_key !== 'string') return undefined;
    const members = workspaces.filter((candidate) => candidate?.worktree?.repo_key === worktree.repo_key);
    if (members.length < 2) return undefined;
    return {
        label: labelOf(worktree.repo_name, labelOf(workspace?.label, 'worktree group')),
        size: members.length,
    };
}

function locate(snapshot, paneId) {
    const panes = Array.isArray(snapshot?.panes) ? snapshot.panes : [];
    const tabs = Array.isArray(snapshot?.tabs) ? snapshot.tabs : [];
    const workspaces = Array.isArray(snapshot?.workspaces) ? snapshot.workspaces : [];
    const pane = panes.find((candidate) => candidate?.pane_id === paneId);
    if (pane === undefined) return undefined;
    const tab = tabs.find((candidate) => candidate?.tab_id === pane.tab_id);
    const workspaceId = pane.workspace_id ?? tab?.workspace_id;
    const workspace = workspaces.find((candidate) => candidate?.workspace_id === workspaceId);
    if (tab === undefined || workspace === undefined) return undefined;
    const paneCount = typeof tab.pane_count === 'number'
        ? tab.pane_count
        : panes.filter((candidate) => candidate?.tab_id === pane.tab_id).length;
    const tabCount = typeof workspace.tab_count === 'number'
        ? workspace.tab_count
        : tabs.filter((candidate) => candidate?.workspace_id === workspaceId).length;
    return {
        paneId,
        tabId: pane.tab_id,
        workspaceId,
        paneCount,
        tabCount,
        group: worktreeGroup(workspaces, workspace),
        tabLabel: labelOf(tab.label, 'tab'),
        workspaceLabel: labelOf(workspace.label, labelOf(workspace.worktree?.repo_name, 'workspace')),
    };
}

function canClosePane(located) {
    return located.paneCount > 1;
}

function canCloseTab(located) {
    return located.paneCount <= 1 && located.tabCount > 1;
}

function canCloseWorkspace(located) {
    return located.paneCount <= 1 && located.tabCount <= 1 && !located.group;
}

function liveCloseScope(located) {
    if (canClosePane(located)) return 'pane';
    if (canCloseTab(located)) return 'tab';
    if (canCloseWorkspace(located)) return 'workspace';
    return 'worktreeGroup';
}

function nextScope(scope) {
    return CLOSE_SCOPES[CLOSE_SCOPES.indexOf(scope) + 1];
}

function nextBroaderScope(attemptedScope, confirmedScope) {
    const attemptedIndex = CLOSE_SCOPES.indexOf(attemptedScope);
    const confirmedIndex = confirmedScope === undefined ? -1 : CLOSE_SCOPES.indexOf(confirmedScope);
    return CLOSE_SCOPES[Math.max(attemptedIndex, confirmedIndex) + 1];
}

function confirmation(scope, located) {
    if (scope === 'tab') {
        return {
            status: 'confirmationRequired',
            scope,
            label: located.tabLabel,
            message: `Closing ${located.tabLabel} will close this tab.`,
        };
    }
    if (scope === 'workspace') {
        return {
            status: 'confirmationRequired',
            scope,
            label: located.workspaceLabel,
            message: `Closing ${located.workspaceLabel} will close this workspace.`,
        };
    }
    const group = located.group;
    const label = group?.label ?? located.workspaceLabel;
    const impact = group === undefined ? 'its worktree group' : `${group.size} workspaces in this worktree group`;
    return {
        status: 'confirmationRequired',
        scope: 'worktreeGroup',
        label,
        message: `Closing ${label} will close ${impact}.`,
    };
}

async function snapshot(call) {
    const result = await call('session.snapshot');
    const value = result?.snapshot ?? result;
    if (value === null || typeof value !== 'object'
        || !Array.isArray(value.panes) || !Array.isArray(value.tabs) || !Array.isArray(value.workspaces)) {
        throw new Error('herdr: session.snapshot: invalid response');
    }
    return value;
}

async function revalidate(call, paneId) {
    try {
        return { located: locate(await snapshot(call), paneId) };
    } catch (error) {
        if (isRetryableHerdr(error)) return { retryable: true };
        throw error;
    }
}

function invoke(call, scope, located) {
    if (scope === 'pane') return call('pane.close', { pane_id: located.paneId });
    if (scope === 'tab') return call('tab.close', { tab_id: located.tabId });
    // Herdr has no group-close RPC; worktreeGroup is explicit consent to the
    // parent workspace.close widening that live topology reported.
    return call('workspace.close', { workspace_id: located.workspaceId });
}

export async function closeAgent({ paneId, confirmedScope, call }) {
    if (typeof paneId !== 'string' || paneId.trim() === '') throw new Error('close requires a paneId');
    if (confirmedScope !== undefined && confirmedScope !== 'tab'
        && confirmedScope !== 'workspace' && confirmedScope !== 'worktreeGroup') {
        throw new Error('invalid close scope');
    }
    let attemptedScope;
    try {
        const live = locate(await snapshot(call), paneId);
        if (live === undefined) return { status: 'closed', alreadyGone: true };
        attemptedScope = liveCloseScope(live);
        const confirmedCeiling = confirmedScope ?? 'pane';
        if (CLOSE_SCOPES.indexOf(attemptedScope) > CLOSE_SCOPES.indexOf(confirmedCeiling)) {
            return confirmation(nextScope(confirmedCeiling), live);
        }
        await invoke(call, attemptedScope, live);
        return { status: 'closed' };
    } catch (error) {
        if (isGoneHerdr(error)) {
            if (attemptedScope === undefined) throw error;
            const latest = await revalidate(call, paneId);
            if (latest.retryable) return { status: 'retryable', message: 'Herdr is temporarily unavailable. Try again.' };
            if (latest.located === undefined) return { status: 'closed', alreadyGone: true };
            throw error;
        }
        if (isNoWidenHerdr(error)) {
            if (attemptedScope === undefined) throw error;
            const latest = await revalidate(call, paneId);
            if (latest.retryable) return { status: 'retryable', message: 'Herdr is temporarily unavailable. Try again.' };
            if (latest.located === undefined) return { status: 'closed', alreadyGone: true };
            const broaderScope = nextBroaderScope(attemptedScope, confirmedScope);
            if (broaderScope === undefined) throw error;
            return confirmation(broaderScope, latest.located);
        }
        if (isRetryableHerdr(error)) {
            return { status: 'retryable', message: 'Herdr is temporarily unavailable. Try again.' };
        }
        throw error;
    }
}

export function createSocketCall(socketPath, timeoutMs = 15_000) {
    // The host supplies the socket for this pinned capability. Guessing a default
    // would silently target a different Herdr than the one that authorized us.
    const path = socketPath
        ?? process.env.MUXR_HERDR_SOCKET_PATH
        ?? process.env.HERDR_SOCKET_PATH;
    if (typeof path !== 'string' || path === '') throw new Error('herdr: no socket path supplied by the host');
    let seq = 0;
    return async (method, params = {}) => {
        const id = `muxr_close_${++seq}`;
        return await new Promise((resolve, reject) => {
            const socket = connect(path);
            let buffer = '';
            let settled = false;
            const timer = setTimeout(() => {
                socket.destroy();
                settle(new Error(`herdr: ${method} timed out`));
            }, timeoutMs);
            const settle = (error, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                socket.removeAllListeners();
                socket.destroy();
                if (error !== undefined) reject(error);
                else resolve(value);
            };
            socket.once('error', (error) => settle(new Error(`herdr: ${method}: ${error.code ?? 'connection_error'}`)));
            socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
            socket.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    if (line.trim() === '') continue;
                    let message;
                    try { message = JSON.parse(line); } catch { continue; }
                    if (message.id !== id) continue;
                    if (message.error !== undefined && message.error !== null) {
                        const detail = message.error;
                        settle(new Error(`herdr: ${detail.code ?? 'error'}: ${detail.message ?? `${method} failed`}`));
                        return;
                    }
                    settle(undefined, message.result ?? {});
                }
            });
            socket.once('close', () => settle(new Error(`herdr: ${method}: connection closed without a response`)));
        });
    };
}
