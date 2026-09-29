/**
 * Plan Account: one sign-in to a provider plan an agent can run on.
 *
 * Vocabulary (CONTEXT.md): "account" here always means a provider sign-in.
 * muxr's own login is an Account Credential and never appears on this surface.
 * Avoid: profile, config dir.
 */

/** One sign-in to a provider plan an agent can run on. */
export interface PlanAccount {
    /** Opaque handle for `session.start.planAccount` and `plans.move`; never displayed. */
    id: string;
    /** The provider the sign-in belongs to: `claude` or `codex` in v1. */
    provider: string;
    /** The person's own name for it; never a number. */
    name: string;
    /** From the tool's own status command; absent when the tool reports none. */
    email?: string;
    /** The plan the tool reports, in its own words. */
    plan?: string;
    /** The sign-in muxr found on this computer, as opposed to one added in-app. */
    foundOnComputer?: true;
    /** A signed-out account is shown but never chosen, with a one-tap Sign in. */
    signedIn: boolean;
    /** Percent of the tightest limit window still left, when the host has a reading. */
    roomLeftPercent?: number;
    /** That window in plain words ("72% left this week"). */
    roomLabel?: string;
}

/** Every known sign-in for one provider. Omitted from `plans.list` below two accounts. */
export interface PlanProviderAccounts {
    provider: string;
    label: string;
    accounts: PlanAccount[];
}
