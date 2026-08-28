import * as React from 'react';
import { useRouter } from 'expo-router';
import { Modal } from '@/modal';
import { t } from '@/text';
import { ActionError } from '@/utils/errors';
import { useAsyncAction } from '@/hooks/useAsyncAction';
import { isWorktreePath } from '../infrastructure/worktree';
import { getSessionName } from '@/herd';
import type { Session } from '@/sync/storageTypes';
import { landWorktreeBranch } from './LandWorktree';

export function useLandWorktree(session: Session | null | undefined) {
    const router = useRouter();
    const path = session?.metadata?.path;
    const canLand = !!session && !!path && isWorktreePath(path);

    const [landing, perform] = useAsyncAction(async () => {
        if (!canLand || path === undefined) return;
        const message = await Modal.prompt(
            t('sessionInfo.landWorktree'),
            t('sessionInfo.landWorktreeMessage'),
            { defaultValue: getSessionName(session!), confirmText: t('sessionInfo.landWorktree') },
        );
        const trimmed = message?.trim();
        if (!trimmed) return;

        const command = {
            worktreePath: path,
            message: trimmed,
            machineId: session!.metadata?.machineId ?? '',
        };
        let result = await landWorktreeBranch(command);

        if (result.status === 'blocked-dirty-base') {
            const shown = result.files.slice(0, 5).join('\n');
            const more = result.files.length > 5 ? `\n… and ${result.files.length - 5} more` : '';
            const agreed = await Modal.confirm(
                t('sessionInfo.landWorktree'),
                `The main checkout has unsaved changes the merge would overwrite:\n${shown}${more}\n\nStash them, land, and put them back?`,
                { confirmText: 'Stash & land' },
            );
            if (!agreed) return;
            result = await landWorktreeBranch({ ...command, stashDirtyBase: true });
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

        if (result.status !== 'conflict') {
            throw new ActionError(result.status === 'failed' ? result.message ?? t('sessionInfo.landWorktreeFailed') : t('sessionInfo.landWorktreeFailed'), false);
        }
        const handoff = await Modal.confirm(
            'Rebase conflict',
            'Git could not rebase the branch cleanly. Start an agent in the main checkout to finish the merge?',
            { confirmText: 'Start agent' },
        );
        if (!handoff) return;
        result = await landWorktreeBranch({ ...command, onConflict: 'handoff', knownConflict: { branch: result.branch, detail: result.detail } });
        if (result.status === 'handoff-started') {
            router.push(`/session/${result.agentRoute}`);
            return;
        }
        throw new ActionError(result.status === 'failed' ? result.message ?? t('sessionInfo.landWorktreeFailed') : t('sessionInfo.landWorktreeFailed'), false);
    });

    return React.useMemo(
        () => ({ canLand, landing, land: perform }),
        [canLand, landing, perform],
    );
}
