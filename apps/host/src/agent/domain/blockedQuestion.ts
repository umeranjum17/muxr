const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
/** Box drawing and block elements a TUI frames its dialog with. */
const FRAME = /[─-▟]/g;
/** "Press enter to confirm or esc to cancel", "Esc to cancel · Tab to amend": how to drive the dialog, not what it asks. */
const KEY_HINT = /^(?:press\s+)?(?:enter|esc|tab|ctrl|↑|↓)\b.*\bto\b/i;
const MAX_LINES = 8;
const MAX_CHARS = 300;

/**
 * What a blocked agent is asking, from the text Herdr read off its pane: the
 * last lines of the dialog, unframed, so a notification can show it. It
 * starts at the question when one ends a line, so its choices are not cut
 * off by the lines a phone has room for.
 */
export function blockedQuestion(screen: string): string | undefined {
    const lines = screen.replace(ANSI, '').split('\n')
        .map((line) => line.replace(FRAME, ' ').replace(/\s+/g, ' ').trim())
        .filter((line) => line !== '' && (line.endsWith('?') || !KEY_HINT.test(line)))
        .slice(-MAX_LINES);
    const asks = lines.findLastIndex((line) => line.endsWith('?'));
    if (asks > 0) lines.splice(0, asks);
    while (lines.length > 1 && lines.join('\n').length > MAX_CHARS) lines.shift();
    const question = lines.join('\n');
    if (question === '') return undefined;
    return question.length > MAX_CHARS ? `${question.slice(0, MAX_CHARS - 1)}…` : question;
}
