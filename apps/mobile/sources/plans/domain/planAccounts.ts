/**
 * Plan Accounts: more than one sign-in to a provider plan, and which one an
 * agent runs on. The host lists only providers with two or more accounts and
 * decides Auto; this module turns that into the phone's words and choices.
 */

import type { PlanAccount, PlanProviderAccounts } from '@trymuxr/contract';

export type { PlanAccount, PlanProviderAccounts };
export type PlanProvider = 'claude' | 'codex';

export interface PlansList {
    providers: PlanProviderAccounts[];
    /** The host's one-time Auto note, until someone has seen it. Absent on an older host. */
    autoTermsAcknowledged?: boolean;
    autoTermsNote?: string;
}

export const AUTO = 'auto';

/** The provider as the person knows its plans: a Codex sign-in is a ChatGPT account. */
const PROVIDER_NAMES: Record<string, string> = { claude: 'Claude', codex: 'ChatGPT' };
export const providerName = (provider: string): string => PROVIDER_NAMES[provider] ?? provider;

/** Which provider's accounts an agent kind runs on. Pi only on a Claude model. */
export function providerForAgent(kind: string): PlanProvider | null {
    if (kind === 'claude' || kind === 'pi') return 'claude';
    if (kind === 'codex') return 'codex';
    return null;
}

/** The provider's entry, present only when it has a real choice of account. */
export function providerEntry(list: PlansList | null, provider: string | null): PlanProviderAccounts | undefined {
    if (list === null || provider === null) return undefined;
    const entry = list.providers.find((candidate) => candidate.provider === provider);
    return entry !== undefined && entry.accounts.length > 1 ? entry : undefined;
}

/** At or below this share left an account reads as low. */
const LOW_LEFT = 20;

export const isLow = (account: PlanAccount): boolean =>
    account.roomLeftPercent !== undefined && account.roomLeftPercent <= LOW_LEFT;

/** The account behind a choice: Auto resolves to the host's pick. */
export function chosenAccount(entry: PlanProviderAccounts, choice: string): PlanAccount | undefined {
    const id = choice === AUTO ? entry.auto.accountId : choice;
    return entry.accounts.find((account) => account.id === id);
}

/**
 * A stored pick that can still be launched on; else Auto, or with Auto
 * turned off the computer's own sign-in (the first signed-in one without it).
 */
export function effectiveChoice(entry: PlanProviderAccounts | undefined, stored: string | undefined, autoOn = true): string {
    const signedIn = entry?.accounts.filter((account) => account.signedIn) ?? [];
    if (signedIn.some((account) => account.id === stored)) return stored!;
    if (autoOn) return AUTO;
    return (signedIn.find((account) => account.foundOnComputer) ?? signedIn[0])?.id ?? '';
}

export function launchAccount(entry: PlanProviderAccounts | undefined, stored: string | undefined, autoOn = true): string | undefined {
    if (entry === undefined) return undefined;
    const choice = effectiveChoice(entry, stored, autoOn);
    return choice === '' ? undefined : choice;
}

export function choiceLine(entry: PlanProviderAccounts, choice: string): { value: string; detail?: string } {
    const account = chosenAccount(entry, choice);
    let value = account?.name ?? 'Auto';
    if (choice === AUTO && account !== undefined) value = `Auto · ${account.name}`;
    return account?.roomLeftPercent === undefined ? { value } : { value, detail: `${account.roomLeftPercent}% left` };
}

/** The best other account to move to: most room left among signed-in ones. */
export function bestMoveTarget(accounts: readonly PlanAccount[], currentId: string | undefined): PlanAccount | undefined {
    return accounts
        .filter((account) => account.signedIn && account.id !== currentId)
        .sort((a, b) => (b.roomLeftPercent ?? -1) - (a.roomLeftPercent ?? -1))[0];
}

/** Which account a running agent is on: the one muxr put it on, else the
 *  computer's own sign-in, which is where any other launch runs. */
export function runningOn(entry: PlanProviderAccounts, recorded: string | undefined): PlanAccount | undefined {
    return entry.accounts.find((account) => account.id === recorded)
        ?? (recorded === undefined ? entry.accounts.find((account) => account.foundOnComputer) : undefined);
}

/** Suggest familiar account names instead of numbering provider sign-ins. */
export function nameSuggestions(account: PlanAccount, taken: readonly string[]): string[] {
    const email = account.email;
    const domain = email?.split('@')[1]?.toLowerCase();
    const personal = domain === undefined || /^(gmail|googlemail|outlook|hotmail|live|icloud|me|yahoo|proton|protonmail|pm)\./.test(domain);
    const options = personal ? ['Personal', 'Work'] : ['Work', 'Personal', domain];
    if (email !== undefined) options.push(email);
    return [...new Set(options)].filter((name): name is string => name !== undefined && !taken.includes(name)).slice(0, 3);
}
