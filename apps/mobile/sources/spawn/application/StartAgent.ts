import { MISSING_CWD_ERROR_PREFIX, type RequestParams } from '@muxr/contract';
import { sync } from '@/catalog/sync';
import { refreshUntilSessionVisible } from '@/catalog/ops';
import {
    getCachedConnectionSettings,
    rememberSessionCwd,
    saveConnectionSettings,
} from '@/connection';
import { SpawnRequest, type SpawnMember } from '../domain/SpawnRequest';

export type StartAgentCommand = {
    directory: string;
    kinds: readonly string[];
    namedMembers: readonly SpawnMember[];
    squad: boolean;
    worktree: boolean;
    createCwd?: boolean;
};

export type StartAgentResult =
    | { ok: true; agentRoute: string }
    | { ok: false; reason: 'rejected' | 'needs-directory' | 'failed'; message?: string };

/** Start one Agent or a squad on the paired Machine. Display names never authorize. */
export async function startAgent(command: StartAgentCommand): Promise<StartAgentResult> {
    const request = new SpawnRequest(
        command.directory,
        command.kinds,
        command.namedMembers,
        command.squad,
        command.worktree,
    );
    const rejected = request.rejection();
    if (rejected) return { ok: false, reason: 'rejected', message: rejected.message };

    try {
        const params = request.startParams(command.createCwd === true) as RequestParams<'session.start'>;
        const snapshot = await sync.request('session.start', params);
        if (!('info' in snapshot)) {
            return {
                ok: false,
                reason: 'failed',
                message: `${snapshot.acceptance.displayName.trim() || 'Agent'} could not start.`,
            };
        }
        await saveConnectionSettings(rememberSessionCwd(getCachedConnectionSettings(), command.directory));
        await refreshUntilSessionVisible(snapshot.info.id);
        return { ok: true, agentRoute: snapshot.info.id };
    } catch (caught: unknown) {
        const message = caught instanceof Error ? caught.message : String(caught);
        if (command.createCwd !== true && message.includes(MISSING_CWD_ERROR_PREFIX)) {
            return { ok: false, reason: 'needs-directory' };
        }
        return { ok: false, reason: 'failed', message: 'Agent could not start. Try again.' };
    }
}
