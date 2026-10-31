import { statSync } from 'node:fs';
import { MOVE_MAX_BYTES, type MoveBundle } from '@trymuxr/contract';
import type { SessionSource } from '../../agent/index.js';
import { planPaneFolder } from '../../plans/index.js';
import { moveAdapter, moveError } from '../domain/adapters.js';
import type { TransferStore } from '../infrastructure/transferStore.js';

const FAILURES: Record<string, [string, string]> = {
    unsupported: ['move-unsupported', "This agent's conversation can't be packaged to move. Use Continue instead; it stays here."],
    'too-large': ['move-too-large', 'This conversation is too long to move. Use Continue instead; it stays here.'],
};

/** Source side: package the idle agent's conversation into one private bundle. The agent and its conversation are never touched. */
export async function exportMove(source: SessionSource, store: TransferStore, env: NodeJS.ProcessEnv, sessionId: string): Promise<MoveBundle> {
    const session = (await source.list({ fresh: true })).find((candidate) => candidate.id === sessionId);
    if (session === undefined) throw moveError('agent-unavailable', 'That agent is no longer available. Refresh and try again.');
    const adapter = moveAdapter(session.agentKind ?? undefined);
    if (adapter === undefined) throw moveError('move-unsupported', 'This kind of agent keeps Continue.');
    const { agentStatus } = await source.status(sessionId);
    if (agentStatus !== 'idle' && agentStatus !== 'done') throw moveError('move-busy', 'Wait for this agent to finish, then move it.');
    if (source.exportConversation === undefined) throw moveError(...FAILURES.unsupported!);
    const target = store.newExport();
    const accountFolder = planPaneFolder(env, session.paneId ?? session.id, adapter.provider);
    const result = await source.exportConversation(sessionId, { to: target.path, maxBytes: MOVE_MAX_BYTES, accountFolder });
    if (!result.ok) {
        store.release(target.id);
        throw moveError(...(FAILURES[result.code] ?? ['move-failed', `The conversation could not be packaged (${result.message}). It stays here.`]));
    }
    return {
        transferId: target.id, kind: result.kind, conversation: result.conversation,
        bytes: statSync(target.path).size, digest: result.digest, cwd: session.cwd ?? '',
        ...(typeof session.taskTitle === 'string' ? { taskTitle: session.taskTitle } : {}),
    };
}
