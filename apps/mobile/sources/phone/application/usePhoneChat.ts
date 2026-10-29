import * as React from 'react';
import type { PhoneAccount, PhoneSession, PhoneTurn } from '@byokit/phone';
import { PHONE_ACCOUNT, PHONE_MEMBER } from '../domain/phone';
import { accounts, endPhoneChat, isSignedIn, openPhoneChat } from './phoneChat';

export type PhoneStage =
    | { kind: 'loading' }
    | { kind: 'signed-out'; note?: string }
    | { kind: 'signing-in'; code: string; url: string }
    | { kind: 'ready'; account: PhoneAccount };

const NOT_STARTED = 'Could not start. Check your connection and try again.';

/** One "Just this phone" screen's state: sign-in, then the chat kept in this phone's file. */
export function usePhoneChat() {
    const [stage, setStage] = React.useState<PhoneStage>({ kind: 'loading' });
    const [turns, setTurns] = React.useState<PhoneTurn[]>([]);
    const [busy, setBusy] = React.useState(false);
    const cancelled = React.useRef(false);
    const session = React.useRef<PhoneSession<string> | undefined>(undefined);

    const ready = React.useCallback(async () => {
        try {
            const opened = await openPhoneChat();
            session.current = opened;
            setTurns(opened.turns);
            setStage({ kind: 'ready', account: await opened.account() });
        } catch (error) {
            setStage({ kind: 'signed-out', note: error instanceof Error && error.message ? error.message : NOT_STARTED });
        }
    }, []);

    React.useEffect(() => {
        let alive = true;
        void isSignedIn().then((signedIn) => {
            if (!alive) return;
            if (signedIn) void ready();
            else setStage({ kind: 'signed-out' });
        }, () => alive && setStage({ kind: 'signed-out', note: NOT_STARTED }));
        return () => { alive = false; };
    }, [ready]);

    const signIn = React.useCallback(async () => {
        cancelled.current = false;
        try {
            const shown = await accounts.login(PHONE_MEMBER, PHONE_ACCOUNT, { via: 'code' });
            if (shown?.state !== 'waiting' || !shown.code || !shown.url) {
                setStage({ kind: 'signed-out', note: shown?.error ?? NOT_STARTED });
                return;
            }
            setStage({ kind: 'signing-in', code: shown.code, url: shown.url });
            await accounts.finished(PHONE_MEMBER, PHONE_ACCOUNT);
            if (cancelled.current) return;
            const status = await accounts.status(PHONE_MEMBER, PHONE_ACCOUNT);
            if (status.state === 'ready') await ready();
            else setStage({ kind: 'signed-out', note: status.words });
        } catch {
            if (!cancelled.current) setStage({ kind: 'signed-out', note: NOT_STARTED });
        }
    }, [ready]);

    const cancelSignIn = React.useCallback(() => {
        cancelled.current = true;
        accounts.cancel(PHONE_MEMBER, PHONE_ACCOUNT);
        setStage({ kind: 'signed-out' });
    }, []);

    // A turn's words come from the kit; the screen only redraws what it holds.
    const run = React.useCallback(async (start: (chat: PhoneSession<string>, onText: () => void) => Promise<PhoneTurn>) => {
        const chat = session.current;
        if (!chat || busy) return;
        const redraw = () => setTurns(chat.turns);
        setBusy(true);
        try {
            const pending = start(chat, redraw);
            redraw();
            await pending;
        } catch {
            // An aborted or refused turn is already in the chat with its words.
        } finally {
            redraw();
            setBusy(false);
        }
    }, [busy]);

    const send = React.useCallback((text: string) => run((chat, onText) => chat.send(text, { onText })), [run]);
    const tryAgain = React.useCallback((requestId: string) => run((chat, onText) => chat.resume(requestId, { onText })), [run]);

    const startOver = React.useCallback(async () => {
        session.current = undefined;
        setTurns([]);
        await endPhoneChat();
        setStage({ kind: 'signed-out' });
    }, []);

    return { stage, turns, busy, signIn, cancelSignIn, send, tryAgain, startOver };
}
