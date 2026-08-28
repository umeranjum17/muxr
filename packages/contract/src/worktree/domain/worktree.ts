/**
 * Landing a worktree: what came of it. Landing never removes the worktree
 * directory -- removal is a separate, explicit action once no session lives
 * in it, so a land can never pull the floor out from under a running agent.
 *
 * `stash` on the request is the answer to `blocked-dirty-base`: the user was
 * shown the overlapping files and agreed to stash, land, and pop.
 */
export type LandWorktreeResult =
    | {
        status: 'landed';
        branch: string;
        /** Branch of the base checkout the work landed on. */
        into: string;
        /** Merge happened but the stash would not re-apply; changes are safe in the stash. */
        stashLeft: boolean;
    }
    | { status: 'already-landed'; branch: string; into: string }
    /** Dirty files in the base checkout that the merge would overwrite. */
    | { status: 'blocked-dirty-base'; files: string[] }
    /** Rebase hit conflicts; step names where, detail is git's own output. */
    | { status: 'conflict'; step: 'rebase'; branch: string; detail: string };

export function landNeedsConsent(result: LandWorktreeResult): boolean {
    return result.status === 'blocked-dirty-base';
}

export function landSucceeded(result: LandWorktreeResult): boolean {
    return result.status === 'landed' || result.status === 'already-landed';
}
