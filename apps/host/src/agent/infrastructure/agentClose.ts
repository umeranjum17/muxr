/**
 * The agent-close ladder: close one pane, widening to tab, workspace, then
 * worktree group only with explicit confirmation at every broader scope.
 *
 * The pane, tab and workspace steps are the kit's closePane/closeTab/
 * closeWorkspace: each refuses a close that would widen and names the wider
 * target, which is the next rung. A worktree-group root's refusal names the
 * group with its repo name and size, and the confirmed group close echoes it
 * back so the kit closes the whole group atomically.
 */
import type { HerdrKit } from '@byokit/herdr';
import type { CloseResult, CloseScope } from '@trymuxr/contract';

export type HerdrCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
export type CloseKit = Pick<HerdrKit, 'closePane' | 'closeTab' | 'closeWorkspace'>;

/** The wider target a kit close refusal names, or undefined when the close went through. */
type Wider = { id: string; label: string; size?: number };

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

// A folder's workspace is labelled with its path; say it as the folder, as Spaces does.
function workspaceLabelOf(value: unknown, fallback: string): string {
    const label = labelOf(value, fallback);
    return /^~?\/./.test(label) ? label.replace(/\/+$/, '').split('/').pop() as string : label;
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
        workspaceLabel: workspaceLabelOf(workspace.label, labelOf(workspace.worktree?.repo_name, 'workspace')),
    };
}

function nextBroaderScope(attemptedScope: string, confirmedScope: CloseScope | undefined): CloseScope | undefined {
    const attemptedIndex = CLOSE_LADDER.indexOf(attemptedScope as (typeof CLOSE_LADDER)[number]);
    const confirmedIndex = confirmedScope === undefined ? -1 : CLOSE_LADDER.indexOf(confirmedScope);
    return CLOSE_LADDER[Math.max(attemptedIndex, confirmedIndex) + 1] as CloseScope | undefined;
}

type Labels = Partial<Pick<Located, 'tabLabel' | 'workspaceLabel' | 'group'>>;

function confirmation(scope: string, located: Labels): CloseResult {
    if (scope === 'tab') {
        // Herdr tab labels are often a bare number; name it so the sentence reads.
        const tabLabel = located.tabLabel ?? 'tab';
        const tab = /^\d+$/.test(tabLabel) ? `Tab ${tabLabel}` : tabLabel;
        return {
            status: 'confirmationRequired',
            scope,
            label: tabLabel,
            message: `Closing ${tab} will close this tab.`,
        };
    }
    const workspaceLabel = located.workspaceLabel ?? 'workspace';
    if (scope === 'workspace') {
        return {
            status: 'confirmationRequired',
            scope,
            label: workspaceLabel,
            message: `Closing ${workspaceLabel} will close this workspace.`,
        };
    }
    const group = located.group;
    const label = group?.label ?? workspaceLabel;
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

export async function widened(close: Promise<void>): Promise<Wider | undefined> {
    try {
        await close;
        return undefined;
    } catch (error) {
        const refusal = error as { code?: unknown; id?: unknown; label?: unknown; size?: unknown } | null;
        if (typeof refusal?.code !== 'string' || !refusal.code.endsWith('-close-would-widen')
            || typeof refusal.id !== 'string') throw error;
        return {
            id: refusal.id,
            label: typeof refusal.label === 'string' ? refusal.label : '',
            ...(typeof refusal.size === 'number' ? { size: refusal.size } : {}),
        };
    }
}

export async function closeAgent({ paneId, confirmedScope, kit, call }: {
    paneId: string;
    confirmedScope?: CloseScope;
    kit: CloseKit;
    call: HerdrCall;
}): Promise<CloseResult> {
    if (typeof paneId !== 'string' || paneId.trim() === '') throw new Error('close requires a paneId');
    if (confirmedScope !== undefined && confirmedScope !== 'tab'
        && confirmedScope !== 'workspace' && confirmedScope !== 'worktreeGroup') {
        throw new Error('invalid close scope');
    }
    const allows = (scope: (typeof CLOSE_LADDER)[number]): boolean =>
        CLOSE_LADDER.indexOf(scope) <= CLOSE_LADDER.indexOf(confirmedScope ?? 'pane');
    let attemptedScope: (typeof CLOSE_LADDER)[number] = 'pane';
    try {
        const tab = await widened(kit.closePane(paneId));
        if (tab === undefined) return { status: 'closed' };
        if (!allows('tab')) return confirmation('tab', { tabLabel: labelOf(tab.label, 'tab') });
        attemptedScope = 'tab';
        const workspace = await widened(kit.closeTab(tab.id));
        if (workspace === undefined) return { status: 'closed' };
        const workspaceLabel = workspaceLabelOf(workspace.label, 'workspace');
        if (!allows('workspace')) return confirmation('workspace', { workspaceLabel });
        attemptedScope = 'workspace';
        // The kit refuses only a worktree-group root here, naming the group's repo and size.
        const group = await widened(kit.closeWorkspace(workspace.id));
        if (group === undefined) return { status: 'closed' };
        if (!allows('worktreeGroup')) {
            return confirmation('worktreeGroup', {
                workspaceLabel,
                ...(group.size === undefined ? {} : { group: { label: labelOf(group.label, workspaceLabel), size: group.size } }),
            });
        }
        attemptedScope = 'worktreeGroup';
        await kit.closeWorkspace(workspace.id, { confirmed: { scope: 'worktreeGroup', id: group.id } });
        return { status: 'closed' };
    } catch (error) {
        if (isGoneHerdr(error)) {
            const latest = await revalidate(call, paneId);
            if (latest.retryable) return { status: 'retryable', message: 'Herdr is temporarily unavailable. Try again.' };
            if (latest.located === undefined) return { status: 'closed', alreadyGone: true };
            throw error;
        }
        if (isNoWidenHerdr(error)) {
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
