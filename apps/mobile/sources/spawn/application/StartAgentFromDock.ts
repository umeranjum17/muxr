import type { Machine } from '@/catalog';
import { machineSpawnNewSession } from '@/catalog/ops';
import { submitPrompt } from '@/catalog/application/submissions';
import { isMachineOnline } from '@/pairing';
import { sync } from '@/catalog/sync';
import { createWorktree } from '../infrastructure/worktree';
import { WorktreeSelection } from '../domain/WorktreeSelection';
import type { NewSessionAgentType } from '@/catalog/application/persistence';
import type { AttachmentPreview } from '@/catalog/infrastructure/attachmentTypes';

export type StartAgentFromDockCommand = {
    machine: Machine | undefined;
    directory: string;
    worktree: WorktreeSelection;
    providerKind: NewSessionAgentType;
    prompt: string;
    attachments: unknown[];
    createCwd?: boolean;
    /** Fires once the route exists, before the first prompt is delivered. */
    onRouteReady?: (sessionId: string) => void;
};

export type StartAgentFromDockResult =
    | { ok: true; agentRoute: string; machineId: string; promptFailed?: string }
    | { ok: false; reason: 'no-machine' | 'offline' | 'worktree-failed' | 'needs-directory' | 'failed'; message?: string; directory?: string };

/**
 * The agent is a TUI, so it reaches a file by having its path in the prompt.
 * Save the images to the host over the session socket, the same way the
 * terminal composer does, and append the paths it returns.
 */
/** Spawn from the Dock: Machine, directory, Worktree, and Agent Kind are already chosen. */
export async function startAgentFromDock(command: StartAgentFromDockCommand): Promise<StartAgentFromDockResult> {
    const machine = command.machine;
    if (!machine) return { ok: false, reason: 'no-machine', message: 'Please select a machine' };
    if (!isMachineOnline(machine)) return { ok: false, reason: 'offline', message: 'Machine is offline' };
    // Ownership is fixed here, before anything asynchronous: the computer
    // this draft is for is the one the transport is on now. It is never
    // re-read later; a switch mid-way is detected against it.
    const owner = sync.currentMachineId();
    if (machine.id !== owner) return { ok: false, reason: 'offline', message: 'That computer is not the connected one. Switch to it, then start the agent.' };

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

    // machineSpawnNewSession already refreshed until the session was listed.
    // The host holds the first prompt until the agent can accept it, which is
    // seconds for some kinds. Show the session now instead of a dead Dock —
    // unless the app moved to another computer meanwhile: A's session is
    // never opened on B.
    if (sync.currentMachineId() === owner) command.onRouteReady?.(result.sessionId);
    if (command.prompt || command.attachments.length > 0) {
        // Stored, uploaded and delivered under the owner captured above; a
        // switch makes delivery refuse and leaves the prompt recoverable on
        // the owner's session.
        const sent = await submitPrompt({ machineId: owner, sessionId: result.sessionId, draft: command.prompt, attachments: [], uploads: command.attachments as AttachmentPreview[], source: 'new_session' });
        if (!sent.ok) return { ok: true, agentRoute: result.sessionId, machineId: owner, promptFailed: sent.submission.reason };
    }
    return { ok: true, agentRoute: result.sessionId, machineId: owner };
}
