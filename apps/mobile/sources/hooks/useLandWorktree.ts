import * as React from 'react';
import { useRouter } from 'expo-router';
import { Modal } from '@/modal';
import { t } from '@/text';
import { HappyError } from '@/utils/errors';
import { useHappyAction } from '@/hooks/useHappyAction';
import { getRepoPath, isWorktreePath, landWorktree } from '@/utils/worktree';
import { getSessionName } from '@/utils/sessionUtils';
import { machineSpawnNewSession } from '@/sync/ops';
import { sync } from '@/sync/sync';
import type { Session } from '@/sync/storageTypes';

/** Plain strings, like the rest of the newer screens: land UI is English-only for now. */
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

export function useLandWorktree(session: Session | null | undefined) {
    const router = useRouter();
    const path = session?.metadata?.path;
    const canLand = !!session && !!path && isWorktreePath(path);

    const [landing, perform] = useHappyAction(async () => {
        if (!canLand) return;
        const message = await Modal.prompt(
            t('sessionInfo.landWorktree'),
            t('sessionInfo.landWorktreeMessage'),
            { defaultValue: getSessionName(session!), confirmText: t('sessionInfo.landWorktree') },
        );
        const trimmed = message?.trim();
        if (!trimmed) return;

        let result = await landWorktree(path!, trimmed, false);

        // The base checkout has unsaved work on files this branch touches.
        // Nothing has moved yet; ask before stashing it aside and back.
        if (result.status === 'blocked-dirty-base') {
            const shown = result.files.slice(0, 5).join('\n');
            const more = result.files.length > 5 ? `\n… and ${result.files.length - 5} more` : '';
            const agreed = await Modal.confirm(
                t('sessionInfo.landWorktree'),
                `The main checkout has unsaved changes the merge would overwrite:\n${shown}${more}\n\nStash them, land, and put them back?`,
                { confirmText: 'Stash & land' },
            );
            if (!agreed) return;
            result = await landWorktree(path!, trimmed, true);
        }

        if (result.status === 'landed') {
            Modal.alert(
                t('sessionInfo.landWorktree'),
                result.stashLeft
                    ? `Landed onto ${result.into}. Your stashed changes did not re-apply cleanly -- they are safe in the stash; run \`git stash pop\` in the main checkout.`
                    : `Landed onto ${result.into}. The worktree is kept; remove it from the session info screen, or sweep all landed worktrees with \`yarn worktrees:clean --yes\`.`,
            );
            return;
        }

        if (result.status === 'already-landed') {
            Modal.alert(t('sessionInfo.landWorktree'), `This branch is already on ${result.into}.`);
            return;
        }

        // Rebase conflicts need a brain, not a script: offer an agent that runs
        // in the base checkout, safely outside the worktree being landed.
        if (result.status !== 'conflict') {
            throw new HappyError(t('sessionInfo.landWorktreeFailed'), false);
        }
        const handoff = await Modal.confirm(
            'Rebase conflict',
            'Git could not rebase the branch cleanly. Start an agent in the main checkout to finish the merge?',
            { confirmText: 'Start agent' },
        );
        if (!handoff) return;
        const spawn = await machineSpawnNewSession({
            machineId: session!.metadata?.machineId ?? '',
            directory: getRepoPath(path!),
        });
        if (spawn.type !== 'success') {
            throw new HappyError(spawn.type === 'error' ? spawn.errorMessage : 'Could not start the agent', false);
        }
        await sync.sendMessage(spawn.sessionId, handoffPrompt(path!, result.branch, result.detail));
        router.push(`/session/${spawn.sessionId}`);
    });

    return React.useMemo(
        () => ({ canLand, landing, land: perform }),
        [canLand, landing, perform],
    );
}
