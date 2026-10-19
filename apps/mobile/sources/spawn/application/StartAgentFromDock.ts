import type { Machine } from '@/catalog';
import { machineSpawnNewSession } from '@/catalog/ops';
import { sync } from '@/catalog/sync';
import { getCachedConnectionSettings, rememberSessionCwd, saveConnectionSettings } from '@/connection';
import { isMachineOnline } from '@/pairing';
import { createWorktree } from './worktree';
import { WorktreeSelection } from '../domain/WorktreeSelection';
import type { NewSessionAgentType } from '@/catalog';
import type { AttachmentPreview } from '@/catalog';
import { readFileBytes } from '@/utils/readFileBytes';
import { encodeBase64 } from '@/encryption/base64';
import { planConnection, samePlanConnection } from '@/plans';
import { appendToDraft, takeQueuedFirstPrompt, useQueuedFirstPrompts } from '@/terminal';
import { useNewSessionDraft } from './useNewSessionDraft';

export type StartAgentFromDockCommand = {
    machine: Machine | undefined;
    directory: string;
    worktree: WorktreeSelection;
    providerKind: NewSessionAgentType;
    prompt: string;
    attachments: unknown[];
    createCwd?: boolean;
    planAccount?: string;
    /** Fires once the route exists, before the first prompt is delivered. */
    onRouteReady?: (sessionId: string) => void;
    /** Fires when the detached first-prompt delivery fails, after route-ready. */
    onPromptFailed?: (failure: FirstPromptFailure) => void;
};

export type FirstPromptFailure = { text: string; message: string };

export type StartAgentFromDockResult =
    | { ok: true; agentRoute: string }
    | { ok: false; reason: 'no-machine' | 'offline' | 'worktree-failed' | 'needs-directory' | 'failed'; message?: string; directory?: string };

/**
 * The agent is a TUI, so it reaches a file by having its path in the prompt.
 * Save the images to the host over the session socket, the same way the
 * terminal composer does, and append the paths it returns. Each saved path is
 * kept on its attachment, so a failed delivery can hand it back as saved.
 */
async function promptWithAttachmentPaths(
    sessionId: string,
    prompt: string,
    attachments: (AttachmentPreview & { path?: string })[],
    connection: ReturnType<typeof planConnection>,
): Promise<string> {
    // One request per file: a whole batch in one frame could pass the link's
    // 16 MB message ceiling, a single file never does.
    for (const attachment of attachments) {
        const data = encodeBase64(await readFileBytes(attachment.uri));
        if (!samePlanConnection(connection)) throw new Error('The computer changed. Start again.');
        const saved = await sync.request('session.saveAttachments', {
            sessionId,
            attachments: [{ name: attachment.name, mimeType: attachment.mimeType, data }],
        });
        const path = saved.savedPaths[0];
        if (path === undefined) throw new Error('The host did not confirm the file. Please attach it again.');
        attachment.path = path;
    }
    return [prompt.trim(), ...attachments.map((attachment) => attachment.path)].filter((part) => part !== '').join(' ');
}

/**
 * A first prompt the host never took belongs to both composers: the agent's
 * screen takes it and its attachments back into its own composer on mount, a
 * saved file as a ready chip reusing its saved path, and Home shows the text
 * again too, since its composer already cleared at route-ready. Anything the
 * person typed on Home since is kept; the failed text joins it, never
 * replacing it.
 */
function restoreFailedFirstPrompt(agentRoute: string, prompt: string, attachments: (AttachmentPreview & { path?: string })[]): void {
    useQueuedFirstPrompts.setState({ [agentRoute]: { text: prompt, attachments, failed: true } });
    if (prompt) {
        const home = useNewSessionDraft.getState();
        home.setInput(appendToDraft(home.input, prompt));
    }
    if (attachments.length > 0) {
        const home = useNewSessionDraft.getState();
        home.setAttachments([...home.attachments, ...attachments.map(({ path: _path, ...preview }) => preview)]);
    }
}

/** Spawn from the Dock: Machine, directory, Worktree, and Agent Kind are already chosen. */
export async function startAgentFromDock(command: StartAgentFromDockCommand): Promise<StartAgentFromDockResult> {
    if (command.providerKind === 'shell' && (command.prompt.trim() !== '' || command.attachments.length > 0)) {
        return { ok: false, reason: 'failed', message: 'Shell has no agent. Choose an agent to send this prompt, or start Shell without a prompt.' };
    }
    const connection = planConnection();
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

    if (!samePlanConnection(connection)) return { ok: false, reason: 'failed', message: 'The computer changed. Start again.' };
    const result = await machineSpawnNewSession({
        machineId: machine.id,
        directory: spawnDirectory,
        approvedNewDirectoryCreation: command.createCwd === true,
        agent: command.providerKind,
        ...(command.planAccount === undefined ? {} : { planAccount: command.planAccount }),
    });
    if (!samePlanConnection(connection)) return { ok: false, reason: 'failed', message: 'The computer changed. Start again.' };
    if (result.type === 'error') return { ok: false, reason: 'failed', message: result.errorMessage };
    if (result.type !== 'success') {
        return { ok: false, reason: 'needs-directory', directory: result.directory, message: result.directory };
    }
    await saveConnectionSettings(rememberSessionCwd(getCachedConnectionSettings(), machine.id, command.directory));

    // machineSpawnNewSession already refreshed until the session was listed.
    // The host holds the first prompt until the agent takes it, which is
    // seconds for some kinds. Show the session now, with the prompt queued.
    const agentRoute = result.sessionId;
    if (!command.prompt && command.attachments.length === 0) {
        command.onRouteReady?.(agentRoute);
        return { ok: true, agentRoute };
    }
    useQueuedFirstPrompts.setState({ [agentRoute]: { text: command.prompt } });
    command.onRouteReady?.(agentRoute);
    // Home is gated on the spawn alone: the first prompt keeps delivering
    // after this returns, so the Home composer is free while the host holds
    // it. A failure restores both composers and reports through onPromptFailed.
    const attachments = (command.attachments as AttachmentPreview[]).map((attachment): AttachmentPreview & { path?: string } => ({ ...attachment }));
    void (async () => {
        try {
            const text = await promptWithAttachmentPaths(agentRoute, command.prompt, attachments, connection);
            if (!samePlanConnection(connection)) throw new Error('The computer changed. Start again.');
            await sync.sendMessage(agentRoute, text, { firstPrompt: true });
            takeQueuedFirstPrompt(agentRoute);
        } catch (error) {
            restoreFailedFirstPrompt(agentRoute, command.prompt, attachments);
            command.onPromptFailed?.({
                text: command.prompt,
                message: error instanceof Error ? error.message : 'Failed to send the first message',
            });
        }
    })();
    return { ok: true, agentRoute };
}
