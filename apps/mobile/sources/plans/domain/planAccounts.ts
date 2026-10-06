/**
 * Plan Accounts: more than one sign-in to a provider plan, and which one an
 * agent runs on. The host lists only providers with two or more accounts and
 * decides Auto; this module turns that into the phone's words and choices.
 */

import { accountNameFrom, type PlanAccount, type PlanProviderAccounts } from '@trymuxr/contract';

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

/** No room left: an agent here can't answer until the account refills. */
export const isEmpty = (account: PlanAccount): boolean => account.roomLeftPercent === 0;

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

/** The person's pick when it can't be launched on now, because it is signed out. */
export function signedOutPick(entry: PlanProviderAccounts | undefined, stored: string | undefined): PlanAccount | undefined {
    return stored === undefined ? undefined : entry?.accounts.find((account) => account.id === stored && !account.signedIn);
}

/** The dock's line. A signed-out pick is named, never swapped for another account in silence. */
export function choiceLine(entry: PlanProviderAccounts, stored: string | undefined, autoOn = true): { value: string; detail?: string } {
    if (!entry.accounts.some((account) => account.signedIn)) {
        const pick = signedOutPick(entry, stored);
        // No signed-in account exists, so there is no other account to offer:
        // the row says so instead of reading a plain Auto.
        return pick === undefined
            ? { value: 'No signed-in account', detail: 'Sign in to start' }
            : { value: `${pick.name} is signed out`, detail: 'Sign in to use it' };
    }
    const choice = effectiveChoice(entry, stored, autoOn);
    const pick = signedOutPick(entry, stored);
    if (pick !== undefined) {
        const instead = chosenAccount(entry, choice);
        return { value: `${pick.name} is signed out`, detail: instead === undefined || !instead.signedIn ? 'Sign in to use it' : `Sign in, or use ${instead.name}` };
    }
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

/** What Start asks before launching on `choice`: the pick is signed out, or
 *  the account it lands on has no room left. `instead` is the choice to
 *  launch on if the person takes the offer; `anyway` starts on `choice`. */
export interface LaunchQuestion {
    title: string;
    message: string;
    instead?: { label: string; choice: string };
    anyway?: string;
}

/** The host's Auto line split into the clock and who refills first, from
 *  "All Claude accounts are out of room until 6:09 PM. Personal refills first."
 *  Its first sentence is this alert's title, so only what follows belongs in
 *  the body. Absent on an older host or a reason in other words. */
const REFILL_REASON = /^All \S+ accounts are out of room(?: until ([^.]+))?\.\s*(\S[^.]*?) refills first\.$/;

/** What an empty account leaves the body to say: the provider's own reset time,
 *  and that starting now buys nothing. Never the title again. */
function emptyRoomMessage(reason: string, providerLabel: string): string {
    const refill = REFILL_REASON.exec(reason);
    const first = refill?.[2];
    const when = refill?.[1] === undefined ? '' : ` at ${refill[1]}`;
    const who = first === undefined ? `A ${providerLabel} account refills first` : `${first} refills first`;
    return `${who}${when}. An agent started now can't answer until then.`;
}

export function launchQuestion(entry: PlanProviderAccounts, stored: string | undefined, choice: string): LaunchQuestion | undefined {
    if (!entry.accounts.some((account) => account.signedIn)) {
        // Nothing to start on: neither Auto nor a pick resolves to a signed-in
        // account, so Start says so instead of launching one that cannot answer.
        const name = providerName(entry.provider);
        return {
            title: `No signed-in ${name} account`,
            message: `Sign in to a ${name} account from the Account row first.`,
        };
    }
    const pick = signedOutPick(entry, stored);
    const account = chosenAccount(entry, choice);
    if (pick !== undefined) {
        return {
            title: `${pick.name} is signed out`,
            message: account === undefined
                ? `Sign in to ${pick.name} from the Account row first.`
                : `This agent would start on ${account.name} instead. To use ${pick.name}, cancel and sign in from the Account row.`,
            ...(account === undefined ? {} : { instead: { label: `Use ${account.name}`, choice } }),
        };
    }
    if (account?.roomLeftPercent !== 0) return undefined;
    const roomier = bestMoveTarget(entry.accounts, account.id);
    if (roomier === undefined || roomier.roomLeftPercent === 0) {
        const name = providerName(entry.provider);
        // Short enough for a modal title on the reference phone at large
        // text; the provider is named in the chooser this comes from.
        return {
            title: 'All accounts are out of room',
            message: emptyRoomMessage(entry.auto.reason, name),
            anyway: 'Start anyway',
        };
    }
    return {
        title: `${account.name} is out of room`,
        message: `An agent started on ${account.name} can't answer until it refills.${roomier.roomLeftPercent === undefined ? '' : ` ${roomier.name} has ${roomier.roomLeftPercent}% left.`}`,
        instead: { label: `Use ${roomier.name}`, choice: roomier.id },
        anyway: 'Start anyway',
    };
}

/** Which account a running agent is on: the one muxr put it on, else the
 *  computer's own sign-in, which is where any other launch runs. */
export function runningOn(entry: PlanProviderAccounts, recorded: string | undefined): PlanAccount | undefined {
    return entry.accounts.find((account) => account.id === recorded)
        ?? (recorded === undefined ? entry.accounts.find((account) => account.foundOnComputer) : undefined);
}

/** Suggest familiar account names instead of numbering provider sign-ins. The
 *  first is the account's own name from its own email, never a repeat of one
 *  `taken`. */
export function nameSuggestions(account: PlanAccount, taken: readonly string[]): string[] {
    const email = account.email;
    const domain = email?.split('@')[1]?.toLowerCase();
    const personal = domain === undefined || /^(gmail|googlemail|outlook|hotmail|live|icloud|me|yahoo|proton|protonmail|pm)\./.test(domain);
    const labels = personal ? ['Personal', 'Work'] : ['Work', 'Personal', domain];
    const held = new Set(taken.map((name) => name.trim().toLowerCase()));
    const options = [accountNameFrom(email, account.provider, taken), ...labels];
    if (email !== undefined) options.push(email);
    return [...new Set(options)]
        .filter((name): name is string => name !== undefined && !held.has(name.trim().toLowerCase()))
        .slice(0, 3);
}
