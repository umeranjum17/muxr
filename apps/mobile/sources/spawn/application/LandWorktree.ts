import { getRepoPath, isWorktreePath, landWorktree } from '../infrastructure/worktree';
import { machineSpawnNewSession } from '@/catalog/ops';
import { sync } from '@/catalog/sync';

export type LandWorktreeCommand = {
    worktreePath: string;
    message: string;
    machineId: string;
    stashDirtyBase?: boolean;
    onConflict?: 'return' | 'handoff';
    knownConflict?: { branch: string; detail: string };
};

export type LandWorktreeResult =
    | { status: 'not-a-worktree' }
    | { status: 'landed'; into: string; stashLeft?: boolean }
    | { status: 'already-landed'; into: string }
    | { status: 'blocked-dirty-base'; files: string[] }
    | { status: 'conflict'; branch: string; detail: string }
    | { status: 'handoff-started'; agentRoute: string }
    | { status: 'failed'; message?: string };

function handoffPrompt(worktreePath: string, branch: string, detail: string): string {
    return [
        `Land the worktree branch "${branch}" (worktree at ${worktreePath}) into this repository's current branch.`,
        'The automated land ran `git rebase` and hit conflicts. Git said:',
        '',
        detail,
        '',
        'Rules: never discard or overwrite uncommitted changes in this checkout; never force-push; keep the branch commits intact.',
        'Finish the rebase (resolve the conflicts), fast-forward this checkout onto the landed branch, and leave the worktree directory alone -- removal is handled separately.',
        'Report what you did in two lines.',
    ].join('\n');
}

/** Merge a Worktree branch into the main checkout. Conflicts may hand off to a new Agent. */
export async function landWorktreeBranch(command: LandWorktreeCommand): Promise<LandWorktreeResult> {
    if (!isWorktreePath(command.worktreePath)) return { status: 'not-a-worktree' };

    let conflict = command.knownConflict;
    if (conflict === undefined) {
        const result = await landWorktree(command.worktreePath, command.message, command.stashDirtyBase === true);
        if (result.status === 'landed' || result.status === 'already-landed' || result.status === 'blocked-dirty-base') {
            return result;
        }
        if (result.status !== 'conflict') return { status: 'failed' };
        conflict = { branch: result.branch, detail: result.detail };
    }
    if (command.onConflict !== 'handoff') {
        return { status: 'conflict', branch: conflict.branch, detail: conflict.detail };
    }

    const spawn = await machineSpawnNewSession({
        machineId: command.machineId,
        directory: getRepoPath(command.worktreePath),
    });
    if (spawn.type !== 'success') {
        return { status: 'failed', message: spawn.type === 'error' ? spawn.errorMessage : 'Could not start the agent' };
    }
    await sync.sendMessage(spawn.sessionId, handoffPrompt(command.worktreePath, conflict.branch, conflict.detail));
    return { status: 'handoff-started', agentRoute: spawn.sessionId };
}
