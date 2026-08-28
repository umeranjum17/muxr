import type { Machine } from '@/sync/storageTypes';
import { useNewSessionDraft } from './useNewSessionDraft';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { Modal } from '@/modal';
import { t } from '@/text';
import { WorktreeSelection } from '../domain/WorktreeSelection';
import { startAgentFromDock } from './StartAgentFromDock';

/** Adapter: Dock draft + confirmations around StartAgentFromDock. */
export async function startSessionFromDraft(options: {
    machines: Machine[];
    navigateToSession: (sessionId: string) => void;
    blank?: boolean;
}): Promise<string | null> {
    const draft = useNewSessionDraft.getState();
    const machine = options.machines.find((candidate) => candidate.id === draft.selectedMachineId);
    const blank = options.blank === true;
    const absolutePath = resolveAbsolutePath(draft.selectedPath?.trim() || '~', machine?.metadata?.homeDir);
    const worktree = WorktreeSelection.fromPickerKey(
        draft.sessionType === 'worktree' ? draft.worktreeKey ?? '__new__' : '__none__',
    );

    let createCwd = false;
    for (;;) {
        const result = await startAgentFromDock({
            machine,
            directory: absolutePath,
            worktree,
            providerKind: draft.agentType,
            prompt: blank ? '' : draft.input.trim(),
            attachments: blank ? [] : draft.attachments,
            createCwd,
        });
        if (result.ok) {
            if (!blank) {
                draft.setInput('');
                draft.setAttachments([]);
            }
            if (result.promptFailed) Modal.alert(t('common.error'), result.promptFailed);
            options.navigateToSession(result.agentRoute);
            return result.agentRoute;
        }
        if (result.reason === 'needs-directory' && !createCwd) {
            const approved = await Modal.confirm(
                'Create Directory?',
                `The directory '${result.directory}' does not exist. Would you like to create it?`,
                { cancelText: t('common.cancel'), confirmText: t('common.create') },
            );
            if (!approved) return null;
            createCwd = true;
            continue;
        }
        Modal.alert(t('common.error'), result.message ?? 'Failed to start session');
        return null;
    }
}
