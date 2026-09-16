import { describe, expect, it } from 'vitest';
import {
    DIALOG_GUARD_ACTION,
    DIALOG_GUARD_MESSAGE,
    DIALOG_GUARD_TITLE,
    terminalInputDisposition,
} from './promptAvailability';

describe('terminal prompt guard', () => {
    it('blocks unrelated input and exposes the one-line jump action', () => {
        expect(terminalInputDisposition(
            { agentStatus: 'blocked' },
            undefined,
            '/model',
        )).toEqual({ kind: 'blocked' });
        expect({ title: DIALOG_GUARD_TITLE, message: DIALOG_GUARD_MESSAGE, action: DIALOG_GUARD_ACTION }).toEqual({
            title: 'Dialog waiting',
            message: 'A dialog is waiting — answer it first, then send.',
            action: 'Show me the message',
        });
    });

    it('passes a literal answer through the outstanding prompt guard', () => {
        expect(terminalInputDisposition(
            undefined,
            { agentState: { requests: { prompt: {} } } },
            'Y',
        )).toEqual({ kind: 'answer', answer: 'y' });
    });
});
