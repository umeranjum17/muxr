/**
 * Auto: which signed-in account an agent starts on, decided once at launch.
 *
 * Rule: skip signed-out accounts; skip accounts whose tightest limit is used
 * up and not yet refilled (a refill time in the past counts as refilled);
 * pick the highest "% left" in each account's tightest window; on a tie pick
 * the one that refills sooner. Never anything mid-conversation, never a
 * per-request rotation. The choice always says which account and why in one
 * plain line.
 */
import type { UsageWindowVM } from '../usage/index.js';

export interface PlanRoomAccount {
    id: string;
    name: string;
    signedIn: boolean;
    windows: UsageWindowVM[];
}

export interface PlanAutoChoice {
    /** The account to start on; undefined when nothing is signed in. */
    accountId: string | undefined;
    /** One plain line naming the choice and why. */
    reason: string;
}

const SPAN_WORD: Record<string, string> = {
    session: 'this session',
    weekly: 'this week',
    monthly: 'this month',
};

export function tightestRoomWindow(vms: readonly UsageWindowVM[]): UsageWindowVM | undefined {
    return vms.reduce<UsageWindowVM | undefined>(
        (worst, vm) => (worst === undefined || vm.percentUsed > worst.percentUsed ? vm : worst),
        undefined,
    );
}

/** The tightest window in plain words ("72% left this week"). */
export function roomLabelFor(vm: UsageWindowVM): string {
    const percent = Math.round(vm.percentRemaining);
    const span = SPAN_WORD[vm.windowKind] ?? 'on its tightest limit';
    return `${percent}% left ${span}`;
}

/** Used up with the refill still ahead: a passed refill counts as refilled. */
function exhausted(vm: UsageWindowVM, nowMs: number): boolean {
    return vm.percentRemaining <= 0 && vm.resetEpochSec !== undefined && vm.resetEpochSec * 1000 > nowMs;
}

export function choosePlanAccount(
    accounts: readonly PlanRoomAccount[],
    providerLabel: string,
    nowMs: number = Date.now(),
): PlanAutoChoice {
    const known = accounts
        .filter((account) => account.signedIn)
        .map((account) => ({ account, tight: tightestRoomWindow(account.windows) }))
        .filter((entry): entry is { account: PlanRoomAccount; tight: UsageWindowVM } => entry.tight !== undefined);
    const usable = known.filter((entry) => !exhausted(entry.tight, nowMs));
    // Roomiest first; on a tie the one that refills sooner (unknown last).
    const byRoom = [...usable].sort(
        (a, b) => b.tight.percentRemaining - a.tight.percentRemaining
            || (a.tight.resetEpochSec ?? Number.POSITIVE_INFINITY) - (b.tight.resetEpochSec ?? Number.POSITIVE_INFINITY),
    );
    const winner = byRoom[0];
    if (winner !== undefined) {
        return {
            accountId: winner.account.id,
            reason: `Right now that's ${winner.account.name}: ${roomLabelFor(winner.tight)}`,
        };
    }
    if (known.length > 0) {
        // Everything is used up: still start, on the one that refills first, and say so.
        const byRefill = [...known].sort(
            (a, b) => (a.tight.resetEpochSec ?? Number.POSITIVE_INFINITY) - (b.tight.resetEpochSec ?? Number.POSITIVE_INFINITY),
        );
        const first = byRefill[0]!;
        const clock = first.tight.resetClock.trim();
        return {
            accountId: first.account.id,
            reason: clock === ''
                ? `All ${providerLabel} accounts are out of room. ${first.account.name} refills first.`
                : `All ${providerLabel} accounts are out of room until ${clock}. ${first.account.name} refills first.`,
        };
    }
    const signedIn = accounts.find((account) => account.signedIn);
    if (signedIn !== undefined) {
        return { accountId: signedIn.id, reason: `Right now that's ${signedIn.name} (no recent reading)` };
    }
    return { accountId: undefined, reason: `No signed-in ${providerLabel} account.` };
}
