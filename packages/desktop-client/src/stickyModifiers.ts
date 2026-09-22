import type { ControlMessage } from './protocol';

/**
 * Ctrl and Shift for a touch keyboard, which has neither.
 *
 * The cycle is the terminal key row's: one tap arms a modifier for the next
 * key, a second tap locks it, a third lets it go. An armed modifier travels
 * with the key it modifies, as that key's own chord, so the desktop never holds
 * a modifier on its own and nothing can be left pressed between keys.
 */
export type StickyModifier = 'Control' | 'Shift';
export type StickyState = 'off' | 'once' | 'lock';
export type StickyModifiers = Readonly<Record<StickyModifier, StickyState>>;

export const NO_MODIFIERS: StickyModifiers = { Control: 'off', Shift: 'off' };

const AFTER_TAP: Record<StickyState, StickyState> = { off: 'once', once: 'lock', lock: 'off' };

export function tapModifier(current: StickyModifiers, name: StickyModifier): StickyModifiers {
    return { ...current, [name]: AFTER_TAP[current[name]] };
}

/** The modifiers the next key carries, in the engine's names. */
export function armedModifiers(current: StickyModifiers): StickyModifier[] {
    return (['Control', 'Shift'] as const).filter((name) => current[name] !== 'off');
}

/** What stays armed once a key has used the modifiers: a lock stays, the rest let go. */
export function afterKey(current: StickyModifiers): StickyModifiers {
    return {
        Control: current.Control === 'lock' ? 'lock' : 'off',
        Shift: current.Shift === 'lock' ? 'lock' : 'off',
    };
}

/**
 * Typed text with modifiers armed: each character is a chord until the armed
 * modifiers are spent, and whatever follows is plain text.
 *
 * A chord names a key, not a case. The phone's keyboard capitalises on its own,
 * and Ctrl with its "V" must still be Ctrl+V, not Ctrl+Shift+V, so a letter is
 * sent lower-case and Shift is pressed only when Shift itself is armed.
 */
export function typeWithModifiers(
    text: string,
    current: StickyModifiers,
): { messages: ControlMessage[]; next: StickyModifiers } {
    const messages: ControlMessage[] = [];
    let next = current;
    let plain = '';
    for (const character of text) {
        const modifiers = armedModifiers(next);
        if (modifiers.length === 0) {
            plain += character;
            continue;
        }
        const key = /^[A-Za-z]$/.test(character) ? character.toLowerCase() : character;
        messages.push(
            { kind: 'key', character: key, modifiers, down: true },
            { kind: 'key', character: key, modifiers, down: false },
        );
        next = afterKey(next);
    }
    if (plain !== '') messages.push({ kind: 'text', text: plain });
    return { messages, next };
}
