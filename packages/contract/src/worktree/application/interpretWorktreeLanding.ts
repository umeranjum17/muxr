import { landNeedsConsent, landSucceeded, type LandWorktreeResult } from '../domain/worktree.js';

export type WorktreeLandingDecision =
    | { kind: 'succeeded' }
    | { kind: 'needs-consent'; files: string[] }
    | { kind: 'conflict'; step: 'rebase'; branch: string; detail: string };

/** Turn a Worktree Landing result into the next human-facing decision. */
export function interpretWorktreeLanding(result: LandWorktreeResult): WorktreeLandingDecision {
    if (landSucceeded(result)) return { kind: 'succeeded' };
    if (landNeedsConsent(result)) return { kind: 'needs-consent', files: result.files };
    return { kind: 'conflict', step: result.step, branch: result.branch, detail: result.detail };
}
