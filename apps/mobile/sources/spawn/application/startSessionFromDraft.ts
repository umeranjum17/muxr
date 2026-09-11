import type { Machine } from '@/catalog';
import { getCachedConnectionSettings } from '@/connection';
import { useNewSessionDraft } from './useNewSessionDraft';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { Modal } from '@/modal';
import { t } from '@/text';
import { WorktreeSelection } from '../domain/WorktreeSelection';
import { startAgentFromDock } from './StartAgentFromDock';
import { useUndeliveredSubmission } from '@/catalog/application/undeliveredSubmission';

/** Adapter: Dock draft + confirmations around StartAgentFromDock. */
export async function startSessionFromDraft(options: {
    machines: Machine[];
    navigateToSession: (sessionId: string) => void;
    blank?: boolean;
}): Promise<string | null> {
    const draft = useNewSessionDraft.getState();
    const machineId = getCachedConnectionSettings().machineId || draft.selectedMachineId;
    const machine = options.machines.find((candidate) => candidate.id === machineId);
    const blank = options.blank === true;
    // A valid selection outside $HOME survives: the host validates the
    // working directory. Machine switches already clear the draft path via
    // setMachineId, and missing directories still ask below.
    const homeDir = machine?.metadata?.homeDir;
    const selectedPath = draft.selectedPath?.trim() || '~';
    const absolutePath = resolveAbsolutePath(selectedPath, homeDir);
    const worktree = WorktreeSelection.fromPickerKey(
        draft.sessionType === 'worktree' ? draft.worktreeKey ?? '__new__' : '__none__',
    );

    let createCwd = false;
    const routed = { sessionId: null as string | null };
    const prompt = blank ? '' : draft.input.trim();
    const attachments = blank ? [] : draft.attachments;
    for (;;) {
        const result = await startAgentFromDock({
            machine,
            directory: absolutePath,
            worktree,
            providerKind: draft.agentType,
            prompt,
            attachments,
            createCwd,
            // Open the session while the first prompt is still in flight.
            onRouteReady: (sessionId) => {
                routed.sessionId = sessionId;
                options.navigateToSession(sessionId);
            },
        });
        if (result.ok) {
            // The session exists either way; a draft left in the Dock would
            // start a second agent. A failed first message waits on the
            // session's own composer instead.
            if (!blank) {
                draft.setInput('');
                draft.setAttachments([]);
            }
            if (result.promptFailed) {
                useUndeliveredSubmission.getState().keep({ sessionId: result.agentRoute, text: prompt, attachments });
            }
            if (routed.sessionId !== result.agentRoute) options.navigateToSession(result.agentRoute);
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
