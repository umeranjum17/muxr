/**
 * The agent-close ladder: close one pane, widening to tab, workspace, then
 * worktree group only with explicit confirmation at every broader scope.
 *
 * This used to live in the workspace-hierarchy plugin folder and ran as a
 * plugin RPC; it is host behavior (session.stop calls it directly), so it
 * lives here as a plain host module. The ladder logic is unchanged.
 */
import type { CloseResult, CloseScope } from '@muxr/contract';

export type HerdrCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

const GONE = new Set(['pane_not_found', 'tab_not_found', 'workspace_not_found']);
const CLOSE_LADDER = ['pane', 'tab', 'workspace', 'worktreeGroup'] as const;

export function herdrErrorCode(error: unknown): string | undefined {
    const message = error instanceof Error ? error.message : String(error);
    return /herdr: ([a-z0-9_]+):/i.exec(message)?.[1];
}

export function isGoneHerdr(error: unknown): boolean {
    const code = herdrErrorCode(error);
    if (code !== undefined && GONE.has(code)) return true;
    const message = error instanceof Error ? error.message : String(error);
    return /no longer available|not found/i.test(message);
}

export function isRetryableHerdr(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /timed out|EACCES|ECONNREFUSED|ECONNRESET|ENOENT|ETIMEDOUT|server_not_running|connection closed|client closed|not running|EPIPE|connect E/i.test(message);
}

export function isNoWidenHerdr(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return herdrErrorCode(error) === 'confirmation_required' || /would (?:also )?close|confirmation required/i.test(message);
}

interface SnapshotPane { pane_id?: unknown; tab_id?: unknown; workspace_id?: unknown }
interface SnapshotTab { tab_id?: unknown; workspace_id?: unknown; label?: unknown; pane_count?: unknown; agentStatus?: unknown }
interface SnapshotWorkspace { workspace_id?: unknown; label?: unknown; tab_count?: unknown; worktree?: { is_linked_worktree?: unknown; repo_key?: unknown; repo_name?: unknown } | null }
interface Snapshot { panes: SnapshotPane[]; tabs: SnapshotTab[]; workspaces: SnapshotWorkspace[] }

interface Located {
    paneId: string;
    tabId: string;
    workspaceId: string;
    paneCount: number;
    tabCount: number;
    group: { label: string; size: number } | undefined;
    tabLabel: string;
    workspaceLabel: string;
}

function labelOf(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function worktreeGroup(workspaces: SnapshotWorkspace[], workspace: SnapshotWorkspace | undefined): Located['group'] {
    const worktree = workspace?.worktree;
    if (worktree?.is_linked_worktree !== false || typeof worktree?.repo_key !== 'string') return undefined;
    const members = workspaces.filter((candidate) => candidate?.worktree?.repo_key === worktree.repo_key);
    if (members.length < 2) return undefined;
    return {
        label: labelOf(worktree.repo_name, labelOf(workspace?.label, 'worktree group')),
        size: members.length,
    };
}

function locate(snapshot: Snapshot, paneId: string): Located | undefined {
    const pane = snapshot.panes.find((candidate) => candidate?.pane_id === paneId);
    if (pane === undefined) return undefined;
    const tab = snapshot.tabs.find((candidate) => candidate?.tab_id === pane.tab_id);
    const workspaceId = pane.workspace_id ?? tab?.workspace_id;
    const workspace = snapshot.workspaces.find((candidate) => candidate?.workspace_id === workspaceId);
    if (tab === undefined || workspace === undefined) return undefined;
    const paneCount = typeof tab.pane_count === 'number'
        ? tab.pane_count
        : snapshot.panes.filter((candidate) => candidate?.tab_id === pane.tab_id).length;
    const tabCount = typeof workspace.tab_count === 'number'
        ? workspace.tab_count
        : snapshot.tabs.filter((candidate) => candidate?.workspace_id === workspaceId).length;
    return {
        paneId,
        tabId: tab.tab_id as string,
        workspaceId: workspaceId as string,
        paneCount,
        tabCount,
        group: worktreeGroup(snapshot.workspaces, workspace),
        tabLabel: labelOf(tab.label, 'tab'),
        workspaceLabel: labelOf(workspace.label, labelOf(workspace.worktree?.repo_name, 'workspace')),
    };
}

function liveCloseScope(located: Located): (typeof CLOSE_LADDER)[number] {
    if (located.paneCount > 1) return 'pane';
    if (located.tabCount > 1) return 'tab';
    if (!located.group) return 'workspace';
    return 'worktreeGroup';
}

function nextScope(scope: string): CloseScope {
    return CLOSE_LADDER[CLOSE_LADDER.indexOf(scope as (typeof CLOSE_LADDER)[number]) + 1] as CloseScope;
}

function nextBroaderScope(attemptedScope: string, confirmedScope: CloseScope | undefined): CloseScope | undefined {
    const attemptedIndex = CLOSE_LADDER.indexOf(attemptedScope as (typeof CLOSE_LADDER)[number]);
    const confirmedIndex = confirmedScope === undefined ? -1 : CLOSE_LADDER.indexOf(confirmedScope);
    return CLOSE_LADDER[Math.max(attemptedIndex, confirmedIndex) + 1] as CloseScope | undefined;
}

function confirmation(scope: string, located: Located): CloseResult {
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

async function snapshot(call: HerdrCall): Promise<Snapshot> {
    const result = await call('session.snapshot');
    const value = (result as { snapshot?: unknown } | null)?.snapshot ?? result;
    if (value === null || typeof value !== 'object'
        || !Array.isArray((value as Snapshot).panes) || !Array.isArray((value as Snapshot).tabs) || !Array.isArray((value as Snapshot).workspaces)) {
        throw new Error('herdr: session.snapshot: invalid response');
    }
    return value as Snapshot;
}

async function revalidate(call: HerdrCall, paneId: string): Promise<{ located: Located | undefined; retryable?: true }> {
    try {
        return { located: locate(await snapshot(call), paneId) };
    } catch (error) {
        if (isRetryableHerdr(error)) return { located: undefined, retryable: true };
        throw error;
    }
}

function invoke(call: HerdrCall, scope: string, located: Located): Promise<unknown> {
    if (scope === 'pane') return call('pane.close', { pane_id: located.paneId });
    if (scope === 'tab') return call('tab.close', { tab_id: located.tabId });
    // Herdr has no group-close RPC; worktreeGroup is explicit consent to the
    // parent workspace.close widening that live topology reported.
    return call('workspace.close', { workspace_id: located.workspaceId });
}

export async function closeAgent({ paneId, confirmedScope, call }: {
    paneId: string;
    confirmedScope?: CloseScope;
    call: HerdrCall;
}): Promise<CloseResult> {
    if (typeof paneId !== 'string' || paneId.trim() === '') throw new Error('close requires a paneId');
    if (confirmedScope !== undefined && confirmedScope !== 'tab'
        && confirmedScope !== 'workspace' && confirmedScope !== 'worktreeGroup') {
        throw new Error('invalid close scope');
    }
    let attemptedScope: (typeof CLOSE_LADDER)[number] | undefined;
    try {
        const live = locate(await snapshot(call), paneId);
        if (live === undefined) return { status: 'closed', alreadyGone: true };
        attemptedScope = liveCloseScope(live);
        const confirmedCeiling = confirmedScope ?? 'pane';
        if (CLOSE_LADDER.indexOf(attemptedScope) > CLOSE_LADDER.indexOf(confirmedCeiling)) {
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
