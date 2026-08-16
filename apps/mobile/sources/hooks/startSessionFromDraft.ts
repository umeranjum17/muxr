import type { Machine } from '@/sync/storageTypes';
import { machineSpawnNewSession } from '@/sync/ops';
import { sync } from '@/sync/sync';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { isMachineOnline } from '@/utils/machineUtils';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { createWorktree } from '@/utils/worktree';
import { Modal } from '@/modal';
import { t } from '@/text';

/** Shared configured machine/project/agent flow for UI and app capabilities. */
export async function startSessionFromDraft(options: {
    machines: Machine[];
    navigateToSession: (sessionId: string) => void;
    blank?: boolean;
}): Promise<string | null> {
    const draft = useNewSessionDraft.getState();
    const machine = options.machines.find((candidate) => candidate.id === draft.selectedMachineId);
    if (!machine) {
        Modal.alert(t('common.error'), 'Please select a machine');
        return null;
    }
    if (!isMachineOnline(machine)) {
        Modal.alert(t('common.error'), 'Machine is offline');
        return null;
    }

    const blank = options.blank === true;
    const prompt = blank ? '' : draft.input.trim();
    const attachments = blank ? [] : draft.attachments;
    const absolutePath = resolveAbsolutePath(draft.selectedPath?.trim() || '~', machine.metadata?.homeDir);
    const worktreeSelection = draft.sessionType === 'worktree' ? draft.worktreeKey ?? '__new__' : '__none__';
    try {
        let spawnDirectory = absolutePath;
        if (worktreeSelection === '__new__') {
            const result = await createWorktree(machine.id, absolutePath);
            if (!result.success) {
                Modal.alert(t('common.error'), result.error || 'Failed to create worktree');
                return null;
            }
            spawnDirectory = result.worktreePath;
        } else if (worktreeSelection !== '__none__') {
            spawnDirectory = worktreeSelection;
        }

        const spawn = async (approvedNewDirectoryCreation = false): Promise<string | null> => {
            const result = await machineSpawnNewSession({
                machineId: machine.id,
                directory: spawnDirectory,
                approvedNewDirectoryCreation,
                agent: draft.agentType,
            });
            if (result.type === 'success') return result.sessionId;
            if (result.type === 'error') {
                Modal.alert(t('common.error'), result.errorMessage);
                return null;
            }
            const approved = await Modal.confirm(
                'Create Directory?',
                `The directory '${result.directory}' does not exist. Would you like to create it?`,
                { cancelText: t('common.cancel'), confirmText: t('common.create') },
            );
            return approved ? spawn(true) : null;
        };

        const sessionId = await spawn();
        if (!sessionId) return null;
        await sync.refreshSessions();
        if (!blank) {
            draft.setInput('');
            draft.setAttachments([]);
        }
        options.navigateToSession(sessionId);
        if (prompt || attachments.length > 0) {
            void sync.sendMessage(sessionId, prompt, { source: 'new_session', attachments }).catch((error) => {
                Modal.alert(t('common.error'), error instanceof Error ? error.message : 'Failed to send the first message');
            });
        }
        return sessionId;
    } catch (error) {
        Modal.alert(t('common.error'), error instanceof Error ? error.message : 'Failed to start session');
        return null;
    }
}
