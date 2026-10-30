const ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[ -/]*[0-~])/g;
/** A line of nothing but a rule or a box edge. */
const RULE = /^[\s─━═│┃╭╮╰╯┌┐└┘├┤┬┴┼╌╍┄┅\-_=|]*$/;
/** The harness's key hints and mode footer: chrome around the work, not the work. */
const FOOTER = /(?:\? for shortcuts|shift\+tab|ctrl\+[a-z]|bypass permissions|accept edits|auto-accept|plan mode on|\/help for help|esc to (?:cancel|clear)|enter to (?:send|submit))/i;
/** The prompt box: its edge `│ > …`, an empty `>` prompt. */
const PROMPT = /^(?:[│┃]\s*)?[>❯›]\s*/;
/** "(12s · esc to interrupt)": the interrupt hint is not progress. */
const INTERRUPT = /\s*[(·]?\s*esc to interrupt\s*\)?/gi;
const LINE_MAX = 160;

/**
 * What the agent is doing now, from the last lines of its own screen: the
 * newest lines that are neither rules, the prompt box nor key hints. Read
 * passively; nothing here asks the host for more than the screen.
 */
export function runningStripLines(screen: string, count = 2): string[] {
    const lines = screen.replace(ESCAPE, '').split('\n').map((line) => line.replace(INTERRUPT, '').replace(/^[\s│┃]+|[\s│┃]+$/g, ''));
    const kept: string[] = [];
    for (let index = lines.length - 1; index >= 0 && kept.length < count; index--) {
        const line = lines[index]!;
        if (RULE.test(line) || PROMPT.test(line) || FOOTER.test(line)) continue;
        kept.unshift(line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}…` : line);
    }
    return kept;
}
