import type { Machine } from '@/sync/storageTypes';
import { machineSpawnNewSession } from '@/sync/ops';
import { sync } from '@/sync/sync';
import { isMachineOnline } from '@/pairing';
import { createWorktree } from '../infrastructure/worktree';
import { WorktreeSelection } from '../domain/WorktreeSelection';
import type { NewSessionAgentType } from '@/sync/persistence';

export type StartAgentFromDockCommand = {
    machine: Machine | undefined;
    directory: string;
    worktree: WorktreeSelection;
    providerKind: NewSessionAgentType;
    prompt: string;
    attachments: unknown[];
    createCwd?: boolean;
};

export type StartAgentFromDockResult =
    | { ok: true; agentRoute: string; promptFailed?: string }
    | { ok: false; reason: 'no-machine' | 'offline' | 'worktree-failed' | 'needs-directory' | 'failed'; message?: string; directory?: string };

/** Spawn from the Dock: Machine, directory, Worktree, and Provider Kind are already chosen. */
export async function startAgentFromDock(command: StartAgentFromDockCommand): Promise<StartAgentFromDockResult> {
    const machine = command.machine;
    if (!machine) return { ok: false, reason: 'no-machine', message: 'Please select a machine' };
    if (!isMachineOnline(machine)) return { ok: false, reason: 'offline', message: 'Machine is offline' };

    let spawnDirectory = command.directory;
    if (command.worktree.wantsNewCheckout()) {
        const created = await createWorktree(machine.id, command.directory);
        if (!created.success) {
            return { ok: false, reason: 'worktree-failed', message: created.error || 'Failed to create worktree' };
        }
        spawnDirectory = created.worktreePath;
    } else if (!command.worktree.isNone()) {
        spawnDirectory = command.worktree.existingPath() ?? command.directory;
    }

    const result = await machineSpawnNewSession({
        machineId: machine.id,
        directory: spawnDirectory,
        approvedNewDirectoryCreation: command.createCwd === true,
        agent: command.providerKind,
    });
    if (result.type === 'error') return { ok: false, reason: 'failed', message: result.errorMessage };
    if (result.type !== 'success') {
        return { ok: false, reason: 'needs-directory', directory: result.directory, message: result.directory };
    }

    await sync.refreshSessions();
    if (command.prompt || command.attachments.length > 0) {
        try {
            await sync.sendMessage(result.sessionId, command.prompt, {
                source: 'new_session',
                attachments: command.attachments as never,
            });
        } catch (error) {
            return {
                ok: true,
                agentRoute: result.sessionId,
                promptFailed: error instanceof Error ? error.message : 'Failed to send the first message',
            };
        }
    }
    return { ok: true, agentRoute: result.sessionId };
}
