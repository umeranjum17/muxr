import * as React from 'react';
import { sync } from '@/catalog/sync';
import { hapticsSelection } from '@/components/haptics';
import { pendingChoices, pendingQuestion, type PendingChoice } from '../domain/promptAvailability';

/** A question can arrive a beat after the status flips, and the next one can
 *  follow the last without the status ever leaving blocked. */
const READ_MS = 1_500;
/** The screen can still show an answered question until the agent redraws. */
const ANSWER_SETTLE_MS = 4_000;
const signature = (choices: readonly PendingChoice[]): string =>
    choices.map((choice) => `${choice.key}\u0000${choice.label}`).join('\n');

export interface PendingAsk {
    choices: PendingChoice[];
    /** The lines of the screen just above the choices: what is being asked. */
    question: string[];
}

const NONE: PendingAsk = { choices: [], question: [] };

function readAsk(text: string, columns: number | undefined): PendingAsk {
    const choices = pendingChoices(text, columns);
    return choices.length === 0 ? NONE : { choices, question: pendingQuestion(text, choices) };
}

/**
 * The question a waiting agent is asking, read from its screen with the
 * passive `pane.read` (in colour, so a button selected only by its background
 * shows; reading never moves the agent's viewport), and `answer`, which types
 * a choice's number, or the arrow presses and Enter that reach it, through
 * the same channel the key row writes to. Both the terminal's answer buttons
 * and the chat's use it, so the two never answer differently.
 */
export function usePendingChoices({ sessionId, waiting, channel, columns }: {
    sessionId: string;
    /** The pane is blocked and this device may answer it. */
    waiting: boolean;
    channel?: { sendText: (text: string) => void };
    /** The terminal grid width in columns the pane is drawn at; wrapped unnumbered labels are rejoined against it. */
    columns?: number;
}): PendingAsk & { answer: (choice: PendingChoice) => void; sent: string | null } {
    const [ask, setAsk] = React.useState<PendingAsk>(NONE);
    /** The label of the choice sent, until the screen asks anything new. */
    const [sent, setSent] = React.useState<string | null>(null);
    const answered = React.useRef<{ signature: string; at: number } | null>(null);

    const show = React.useCallback((next: PendingAsk): void => {
        if (next.choices.length > 0) setSent(null);
        setAsk((current) => (signature(current.choices) === signature(next.choices) && current.question.join('\n') === next.question.join('\n') ? current : next));
    }, []);

    React.useEffect(() => {
        if (!waiting) {
            answered.current = null;
            setSent(null);
            setAsk(NONE);
            return;
        }
        let alive = true;
        let timer: ReturnType<typeof setTimeout>;
        const read = async (): Promise<void> => {
            try {
                const { text } = await sync.request('pane.read', { sessionId, source: 'visible', ansi: true });
                if (!alive) return;
                const next = readAsk(text, columns);
                const last = answered.current;
                if (last !== null && last.signature === signature(next.choices) && Date.now() - last.at < ANSWER_SETTLE_MS) return;
                show(next);
            } catch {
                if (alive) setAsk(NONE);
            } finally {
                if (alive) timer = setTimeout(() => { void read(); }, READ_MS);
            }
        };
        void read();
        return () => {
            alive = false;
            clearTimeout(timer);
        };
    }, [columns, sessionId, show, waiting]);

    const answer = React.useCallback((choice: PendingChoice): void => {
        if (channel === undefined) return;
        const last = answered.current;
        if (last !== null && Date.now() - last.at < ANSWER_SETTLE_MS) return;
        answered.current = { signature: signature(ask.choices), at: Date.now() };
        setAsk(NONE);
        if (choice.number !== undefined) {
            hapticsSelection();
            setSent(choice.label);
            channel.sendText(choice.key);
            return;
        }
        void (async () => {
            try {
                const { text } = await sync.request('pane.read', { sessionId, source: 'visible', ansi: true });
                const fresh = readAsk(text, columns);
                const match = fresh.choices.find((candidate) => candidate.number === undefined && candidate.label === choice.label);
                if (match === undefined) {
                    answered.current = null;
                    show(fresh);
                    return;
                }
                answered.current = { signature: signature(fresh.choices), at: Date.now() };
                hapticsSelection();
                setSent(match.label);
                channel.sendText(match.key);
            } catch {
                answered.current = null;
            }
        })();
    }, [ask.choices, channel, columns, sessionId, show]);

    return { ...ask, answer, sent };
}
