import type { Machine } from '@/catalog';
import { machineSpawnNewSession } from '@/catalog/ops';
import { sync } from '@/catalog/sync';
import { isMachineOnline } from '@/pairing';
import { createWorktree } from '../infrastructure/worktree';
import { WorktreeSelection } from '../domain/WorktreeSelection';
import type { NewSessionAgentType } from '@/catalog/application/persistence';
import type { AttachmentPreview } from '@/catalog/infrastructure/attachmentTypes';
import { readFileBytes } from '@/utils/readFileBytes';
import { encodeBase64 } from '@/encryption/base64';

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
    | { ok: true; agentRoute: string; promptFailed?: string }
    | { ok: false; reason: 'no-machine' | 'offline' | 'worktree-failed' | 'needs-directory' | 'failed'; message?: string; directory?: string };

/**
 * The agent is a TUI, so it reaches a file by having its path in the prompt.
 * Save the images to the host over the session socket, the same way the
 * terminal composer does, and append the paths it returns.
 */
async function promptWithAttachmentPaths(
    sessionId: string,
    prompt: string,
    previews: unknown[],
): Promise<string> {
    if (previews.length === 0) return prompt;
    const attachments = [];
    for (const preview of previews as AttachmentPreview[]) {
        attachments.push({
            name: preview.name,
            mimeType: preview.mimeType,
            data: encodeBase64(await readFileBytes(preview.uri)),
        });
    }
    const saved = await sync.request('session.saveAttachments', { sessionId, attachments });
    return [prompt.trim(), ...saved.savedPaths].filter((part) => part !== '').join(' ');
}

/** Spawn from the Dock: Machine, directory, Worktree, and Agent Kind are already chosen. */
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

    // machineSpawnNewSession already refreshed until the session was listed.
    // The host holds the first prompt until the agent can accept it, which is
    // seconds for some kinds. Show the session now instead of a dead Dock.
    command.onRouteReady?.(result.sessionId);
    if (command.prompt || command.attachments.length > 0) {
        try {
            const text = await promptWithAttachmentPaths(result.sessionId, command.prompt, command.attachments);
            await sync.sendMessage(result.sessionId, text, { source: 'new_session' });
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
