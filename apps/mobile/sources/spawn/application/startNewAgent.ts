/**
 * Starting an Agent (or a squad) from the new-agent picker: catalog copy,
 * workspace join path, and the session.start loop including "create this
 * directory?" confirmation.
 */

import { router } from 'expo-router';
import { sync } from '@/sync/sync';
import { refreshUntilSessionVisible } from '@/sync/ops';
import { MISSING_CWD_ERROR_PREFIX, type HerdrTreeWorkspace } from '@muxr/contract';
import { Modal } from '@/modal';
import {
    getCachedConnectionSettings,
    rememberSessionCwd,
    saveConnectionSettings,
} from '@/state/connectionSettings';
import type { AgentCatalogOption } from '@/sync/agentKinds';
import { SpawnRequest } from '../domain/SpawnRequest';

export type CatalogSource = 'loading' | 'host' | 'unknown' | 'fallback';

export function catalogSourceLabel(source: CatalogSource): string {
    if (source === 'host') return 'FROM HERDR';
    if (source === 'loading') return 'CHECKING HOST';
    if (source === 'unknown') return 'HOST AVAILABILITY UNKNOWN';
    return 'OFFLINE FALLBACK';
}

export function agentAvailabilityLabel(
    availability: AgentCatalogOption['availability'],
    catalogSource: CatalogSource,
): string | undefined {
    if (availability === 'installed') return 'Installed';
    if (availability === 'unavailable') return 'Not installed';
    if (catalogSource === 'loading') return 'Checking host';
    return undefined;
}

export function agentAvailabilitySpoken(
    availability: AgentCatalogOption['availability'],
    catalogSource: CatalogSource,
): string {
    if (availability === 'installed') return 'installed';
    if (availability === 'unavailable') return 'not installed';
    if (catalogSource === 'loading') return 'checking installation';
    return 'installation status unknown';
}

export function startButtonLabel(kinds: readonly string[]): string {
    return new SpawnRequest('', kinds, [], kinds.length > 1, false).startButtonLabel();
}

export function workspaceJoinPath(workspace: HerdrTreeWorkspace): string | undefined {
    if (workspace.worktree?.path !== undefined) return workspace.worktree.path;
    if (workspace.label !== undefined && workspace.label.startsWith('/')) return workspace.label;
    return undefined;
}

export function namedMembersHaveDuplicates(
    namedMembers: ReadonlyArray<{ displayName?: string }>,
): boolean {
    return new SpawnRequest('', [], namedMembers.map((member) => ({ kind: '', ...member })), false, false).hasDuplicateNames();
}

export async function startNewAgent(input: {
    directory: string;
    kinds: readonly string[];
    namedMembers: ReadonlyArray<{ kind: string; displayName?: string }>;
    squad: boolean;
    worktree: boolean;
}): Promise<{ error?: string; cancelled?: boolean }> {
    const request = new SpawnRequest(input.directory, input.kinds, input.namedMembers, input.squad, input.worktree);
    const rejected = request.rejection();
    if (rejected) return { error: rejected.message };

    let createCwd = false;
    for (;;) {
        try {
            const snapshot = await sync.request('session.start', {
                cwd: input.directory,
                ...(createCwd ? { createCwd: true } : {}),
                ...(input.squad
                    ? { kinds: [...input.kinds], members: [...input.namedMembers] }
                    : {
                        kind: input.kinds[0],
                        ...(input.namedMembers[0]?.displayName === undefined
                            ? {}
                            : { displayName: input.namedMembers[0].displayName }),
                    }),
                ...(input.worktree ? { worktree: {} } : {}),
            });
            if (!('info' in snapshot)) {
                return { error: `${snapshot.acceptance.displayName.trim() || 'Agent'} could not start.` };
            }
            await saveConnectionSettings(rememberSessionCwd(getCachedConnectionSettings(), input.directory));
            await refreshUntilSessionVisible(snapshot.info.id);
            router.replace(`/session/${snapshot.info.id}`);
            return {};
        } catch (caught: unknown) {
            const message = caught instanceof Error ? caught.message : String(caught);
            if (!createCwd && message.includes(MISSING_CWD_ERROR_PREFIX)) {
                createCwd = await Modal.confirm(
                    'Create directory?',
                    `${input.directory} does not exist. Create it?`,
                    { confirmText: 'Create', cancelText: 'Cancel' },
                );
                if (createCwd) continue;
                return { cancelled: true };
            }
            return { error: 'Agent could not start. Try again.' };
        }
    }
}
