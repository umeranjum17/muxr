import type { Machine } from '@/catalog';
import { getCachedConnectionSettings } from '@/connection';
import { useNewSessionDraft } from './useNewSessionDraft';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { Modal } from '@/modal';
import { t } from '@/text';
import { WorktreeSelection } from '../domain/WorktreeSelection';
import { startAgentFromDock } from './StartAgentFromDock';
import { planConnection, samePlanConnection, refreshPlans, acknowledgeAutoTerms, planAccountForLaunch, unseenAutoTerms } from '@/plans';

function pathForeignToHome(path: string, homeDir: string): boolean {
    if (path === '~' || (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path))) return false;
    const home = homeDir.replace(/[/\\]+$/, '');
    return path !== home && !path.startsWith(`${home}/`) && !path.startsWith(`${home}\\`);
}

/** Adapter: Dock draft + confirmations around StartAgentFromDock. */
export async function startSessionFromDraft(options: {
    machines: Machine[];
    navigateToSession: (sessionId: string) => void;
    blank?: boolean;
}): Promise<string | null> {
    const connection = planConnection();
    const draft = useNewSessionDraft.getState();
    const machineId = getCachedConnectionSettings().machineId || draft.selectedMachineId;
    const machine = options.machines.find((candidate) => candidate.id === machineId);
    const blank = options.blank === true;
    const homeDir = machine?.metadata?.homeDir;
    let selectedPath = draft.selectedPath?.trim() || '~';
    if (homeDir && pathForeignToHome(selectedPath, homeDir)) {
        selectedPath = '~';
        draft.setPath(null);
    }
    const absolutePath = resolveAbsolutePath(selectedPath, homeDir);
    const worktree = WorktreeSelection.fromPickerKey(
        draft.sessionType === 'worktree' ? draft.worktreeKey ?? '__new__' : '__none__',
    );

    let createCwd = false;
    await refreshPlans(connection);
    if (!samePlanConnection(connection)) return null;
    const planAccount = planAccountForLaunch(draft.agentType);
    const termsNote = planAccount === 'auto' ? unseenAutoTerms() : undefined;
    if (termsNote !== undefined) {
        const approved = await Modal.confirm('Auto accounts', termsNote, { cancelText: 'Cancel', confirmText: 'Continue' });
        if (!approved || !samePlanConnection(connection)) return null;
        try {
            await acknowledgeAutoTerms(connection);
        } catch {
            Modal.alert('Auto accounts', 'Could not save that the note was shown. Try again.');
            return null;
        }
    }
    for (;;) {
        if (!samePlanConnection(connection)) return null;
        const result = await startAgentFromDock({
            machine,
            directory: absolutePath,
            worktree,
            providerKind: draft.agentType,
            prompt: blank ? '' : draft.input.trim(),
            attachments: blank ? [] : draft.attachments,
            createCwd,
            ...(planAccount === undefined ? {} : { planAccount }),
        });
        if (!samePlanConnection(connection)) return null;
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
            if (!approved || !samePlanConnection(connection)) return null;
            createCwd = true;
            continue;
        }
        Modal.alert(t('common.error'), result.message ?? 'Failed to start session');
        return null;
    }
}
