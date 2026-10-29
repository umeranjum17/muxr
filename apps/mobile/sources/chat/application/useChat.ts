import * as React from 'react';
import { AppState } from 'react-native';
import type { ChatMessage } from '@trymuxr/contract';
import { chatRead } from '@/catalog/ops';
import { humanError } from '@/utils/errors';

/** How often an open chat asks the host whether the log moved. */
const POLL_MS = 2_000;

export type ChatState =
    | { status: 'loading' }
    | { status: 'ready'; messages: ChatMessage[]; truncated: boolean }
    | { status: 'unavailable'; reason: 'unsupported-agent' | 'no-conversation' }
    | { status: 'failed'; message: string; outdatedHost: boolean };

/**
 * The agent's conversation while its screen is open. The host answers
 * `unchanged` until the log grows, so a quiet agent costs one tiny frame per
 * poll, and nothing is asked while the screen is not focused or the app is behind.
 */
export function useChat(sessionId: string, active: boolean): ChatState {
    const [state, setState] = React.useState<ChatState>({ status: 'loading' });
    React.useEffect(() => {
        if (!active) return;
        let stopped = false;
        let revision: string | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const poll = async (): Promise<void> => {
            if (AppState.currentState === 'active') {
                try {
                    const read = await chatRead(sessionId, revision);
                    if (stopped) return;
                    if (read.state === 'ok') {
                        revision = read.revision;
                        setState({ status: 'ready', messages: read.messages, truncated: read.truncated });
                    } else if (read.state === 'unavailable') {
                        revision = undefined;
                        setState({ status: 'unavailable', reason: read.reason });
                    }
                } catch (error) {
                    if (stopped) return;
                    const code = (error as { code?: string }).code;
                    setState({ status: 'failed', message: humanError(error).message, outdatedHost: code === 'host-contract-mismatch' });
                }
            }
            if (!stopped) timer = setTimeout(() => { void poll(); }, POLL_MS);
        };
        void poll();
        return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
    }, [sessionId, active]);
    return state;
}
