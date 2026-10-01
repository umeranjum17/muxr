import type { AgentLifecycle, HerdrTreePane } from '@trymuxr/contract';

export function terminalPaneStatus(pane: HerdrTreePane | undefined): AgentLifecycle {
    return pane?.promptable === true ? pane.agentStatus : 'unknown';
}

export interface PendingChoice {
    /** What to type: the choice's own number, which selects and confirms it. */
    key: string;
    label: string;
}

const CHOICE_LINE = /^\s*(?:[❯›]\s*)?(\d)\.\s+(\S.*?)\s*$/;
/** Lines a question may show under its last choice: "Esc to cancel", "Press enter to continue". */
const FOOTER_LINES = 6;
/** Lines a long choice may wrap onto at phone width before the next one. */
const WRAP_LINES = 4;

/**
 * The numbered choices an agent is waiting on at the live edge of its screen:
 * Claude Code's "❯ 1. Yes / 2. … / 4. No", Codex's "› 1. Yes, continue".
 * Typing the number selects and confirms in both, so a choice's key is its
 * number. Only a run numbered 1..n at the bottom of the screen counts; a
 * numbered list higher up is the agent talking, not asking.
 */
export function pendingChoices(screen: string): PendingChoice[] {
    const lines = screen.split('\n').filter((line) => line.trim() !== '');
    const found: PendingChoice[] = [];
    let gap: string[] = [];
    for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index]!;
        const match = CHOICE_LINE.exec(line);
        const expected = found.length === 0 ? undefined : String(Number(found[0]!.key) - 1);
        if (match !== null) {
            if (expected !== undefined && match[1] !== expected) return [];
            const indent = line.length - line.trimStart().length;
            if (gap.some((wrapped) => /^\s*(?:\S+\s+)?\d[.)]\s+/.test(wrapped))) return [];
            const wrapLines = gap.reverse();
            const footer = wrapLines.findIndex((wrapped) => wrapped.length - wrapped.trimStart().length <= indent);
            if (found.length > 0 && footer !== -1) return [];
            const continuation = found.length === 0 && footer !== -1 ? wrapLines.slice(0, footer) : wrapLines;
            if (continuation.length > WRAP_LINES || wrapLines.length - continuation.length > FOOTER_LINES) return [];
            found.unshift({ key: match[1]!, label: [match[2]!, ...continuation.map((wrapped) => wrapped.trim())].join(' ') });
            if (match[1] === '1') break;
            gap = [];
            continue;
        }
        gap.push(line);
        if (gap.length > (found.length === 0 ? FOOTER_LINES + WRAP_LINES : WRAP_LINES)) return [];
    }
    return found.length >= 2 && found[0]!.key === '1' ? found : [];
}

/**
 * A pane running an agent accepts a prompt even before it is promptable: the
 * host holds the prompt until the agent can take it. A pane with no agent has
 * nothing to prompt, but a shell takes the draft as a typed line once there is
 * a terminal this device may type into.
 */
export function terminalPaneCanSend(pane: HerdrTreePane | undefined, hasContent: boolean, canType = false): boolean {
    if (pane === undefined || !hasContent) return false;
    return pane.agentKind !== undefined || canType;
}

export function terminalComposerText(draft: string, attachedPaths: string[], isShell: boolean): string {
    const content = isShell && draft.trim() !== '' ? draft : draft.trim();
    return [content, ...attachedPaths].filter((part) => part !== '').join(' ');
}
