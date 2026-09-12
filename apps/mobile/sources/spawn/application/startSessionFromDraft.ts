import type { Machine } from '@/catalog';
import { getCachedConnectionSettings } from '@/connection';
import { useNewSessionDraft } from './useNewSessionDraft';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { Modal } from '@/modal';
import { t } from '@/text';
import { WorktreeSelection } from '../domain/WorktreeSelection';
import { startAgentFromDock } from './StartAgentFromDock';

/**
 * One submission at a time, app-wide. The Dock, focus mode, the sidebar's
 * New session and the New Agent screen all submit the same draft; a second
 * Send while the first is in flight must not start a second agent for the
 * same intent, whichever surface it came from.
 */
let inFlight: Promise<string | null> | null = null;

/** The draft exactly as it was submitted, so only that version is cleared. */
function submittedDraftUnchanged(text: string, attachmentIds: string[]): boolean {
    const current = useNewSessionDraft.getState();
    return current.input.trim() === text
        && current.attachments.length === attachmentIds.length
        && current.attachments.every((item, index) => item.id === attachmentIds[index]);
}

/** Adapter: Dock draft + confirmations around StartAgentFromDock. */
export function startSessionFromDraft(options: {
    machines: Machine[];
    navigateToSession: (sessionId: string) => void;
    blank?: boolean;
}): Promise<string | null> {
    if (inFlight !== null) return inFlight;
    inFlight = submitDraft(options).finally(() => { inFlight = null; });
    return inFlight;
}

async function submitDraft(options: {
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
    const attachmentIds = attachments.map((item) => item.id);
    for (;;) {
        const result = await startAgentFromDock({
            machine,
            directory: absolutePath,
            worktree,
            providerKind: draft.agentType,
            prompt,
            attachments,
            createCwd,
            // The session exists: the submitted draft now belongs to it, so
            // the Dock releases exactly that version -- never text or images
            // typed since -- and the route opens while delivery continues.
            onRouteReady: (sessionId) => {
                routed.sessionId = sessionId;
                if (!blank && submittedDraftUnchanged(prompt, attachmentIds)) {
                    const current = useNewSessionDraft.getState();
                    current.setInput('');
                    current.setAttachments([]);
                }
                options.navigateToSession(sessionId);
            },
        });
        if (result.ok) {
            // A failed first message already waits on the session's own
            // submissions; nothing is cleared here, since the draft may be B.
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
