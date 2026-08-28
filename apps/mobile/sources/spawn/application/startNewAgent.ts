/**
 * Starting an Agent (or a squad) from the new-agent picker: catalog copy,
 * workspace join path, and the session.start loop including "create this
 * directory?" confirmation.
 */

import { router } from 'expo-router';
import { Modal } from '@/modal';
import type { HerdrTreeWorkspace } from '@muxr/contract';
import type { AgentCatalogOption } from '@/catalog';
import { SpawnRequest } from '../domain/SpawnRequest';
import { startAgent } from './StartAgent';

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
    return new SpawnRequest('', kinds, kinds.length > 1, false).startButtonLabel();
}

export function workspaceJoinPath(workspace: HerdrTreeWorkspace): string | undefined {
    if (workspace.worktree?.path !== undefined) return workspace.worktree.path;
    if (workspace.label !== undefined && workspace.label.startsWith('/')) return workspace.label;
    return undefined;
}


export async function startNewAgent(input: {
    directory: string;
    kinds: readonly string[];
    squad: boolean;
    worktree: boolean;
}): Promise<{ error?: string; cancelled?: boolean }> {
    let createCwd = false;
    for (;;) {
        const result = await startAgent({ ...input, createCwd });
        if (result.ok) {
            router.replace(`/session/${result.agentRoute}`);
            return {};
        }
        if (result.reason === 'needs-directory' && !createCwd) {
            createCwd = await Modal.confirm(
                'Create directory?',
                `${input.directory} does not exist. Create it?`,
                { confirmText: 'Create', cancelText: 'Cancel' },
            );
            if (createCwd) continue;
            return { cancelled: true };
        }
        return { error: result.message };
    }
}
