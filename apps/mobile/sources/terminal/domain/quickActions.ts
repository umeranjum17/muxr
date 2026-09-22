/**
 * Quick actions: the short prompts and slash commands a person keeps on this
 * device. Two kinds in one list — a reply is prose for the agent, a command is
 * the slash command they typed once and never want to type again — and both
 * send on tap, because an action that only fills the prompt asks to be sent
 * twice.
 *
 * The three the app ships with are seeds in this same list rather than a
 * separate hardcoded row, so they are editable, reorderable and removable like
 * anything else here. They are convenience text, not a prompt marketplace and
 * not a cross-device store, so the bounds are small and the validator rejects
 * rather than truncates.
 */

export const QUICK_ACTION_LIMIT = 32;
export const QUICK_ACTION_LABEL_LIMIT = 80;
export const QUICK_ACTION_TEXT_LIMIT = 8 * 1024;

export type QuickActionKind = 'reply' | 'command';

export interface QuickAction {
    /** Stable on this device; actions are reordered and edited by it. */
    id: string;
    kind: QuickActionKind;
    label: string;
    text: string;
}

/**
 * What a device with no list of its own starts from: the same three it has
 * always shown. They are seeds, not fixtures — once anything is saved, this
 * list has no further say, and the editor's reset is the way back to it.
 */
export const DEFAULT_QUICK_ACTIONS: readonly QuickAction[] = [
    { id: 'seed-continue', kind: 'reply', label: 'Continue', text: 'Continue with the current task.' },
    { id: 'seed-run-tests', kind: 'reply', label: 'Run tests', text: 'Run the relevant tests and report any failures.' },
    { id: 'seed-summarize', kind: 'reply', label: 'Summarize', text: 'Summarize what changed and what remains.' },
];

/**
 * The list a person actually sees: their own arrangement when they have made
 * one — including the empty one, which is a choice and not an absence — else
 * the seeds.
 */
export function resolveQuickActions(stored: readonly QuickAction[] | null | undefined): QuickAction[] {
    if (stored === null || stored === undefined) return DEFAULT_QUICK_ACTIONS.map((action) => ({ ...action }));
    return [...stored];
}

/**
 * Whether a tap on this action sends it. Text still carrying a {placeholder}
 * is not finished, so it lands in the prompt with the keyboard up instead of
 * going out half-written. Every action can be filled rather than sent through
 * the row's own edit control, so this rule only picks what a plain tap means.
 */
export function quickActionSends(text: string): boolean {
    return !/\{[^{}\n]+\}/.test(text);
}

/** Human-readable reasons an action would be rejected; empty means it may save. */
export function quickActionErrors(label: string, text: string): string[] {
    const errors: string[] = [];
    if (label.trim() === '') errors.push('Give it a name.');
    else if (label.length > QUICK_ACTION_LABEL_LIMIT) errors.push(`Keep the name to ${QUICK_ACTION_LABEL_LIMIT} characters.`);
    if (text.trim() === '') errors.push('Give it something to send.');
    else if (text.length > QUICK_ACTION_TEXT_LIMIT) errors.push(`Keep the text to ${QUICK_ACTION_TEXT_LIMIT.toLocaleString()} characters.`);
    return errors;
}
