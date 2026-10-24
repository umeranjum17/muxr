import React from 'react';
import { hapticsError, hapticsLight } from '@/components/haptics';

/** Where the composer's last send is: on its way, typed into the pane, or refused. */
export type SendDelivery = 'sending' | 'sent' | 'failed';

/** How long "Sent" stays once the host confirms the text reached the pane. */
const SENT_SHOWN_MS = 1600;

/**
 * The composer's send from tap to the host's answer. The tap is felt at once,
 * and the row under the terminal says the text is on its way until the host
 * confirms Herdr typed it into the pane. Only the latest send speaks: an
 * earlier one confirming late never replaces it, but a failure always shows,
 * since its text came back into the field.
 */
export function useSendDelivery(): {
    delivery: SendDelivery | null;
    start: () => number;
    settle: (send: number, outcome: 'sent' | 'failed') => void;
} {
    const [delivery, setDelivery] = React.useState<SendDelivery | null>(null);
    const latest = React.useRef(0);
    const fade = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    React.useEffect(() => () => clearTimeout(fade.current), []);
    const start = React.useCallback(() => {
        clearTimeout(fade.current);
        hapticsLight();
        setDelivery('sending');
        latest.current += 1;
        return latest.current;
    }, []);
    const settle = React.useCallback((send: number, outcome: 'sent' | 'failed') => {
        if (outcome === 'failed') {
            // Sends still in flight confirm quietly: the refused text is back in the field.
            latest.current += 1;
            clearTimeout(fade.current);
            hapticsError();
            setDelivery('failed');
            return;
        }
        if (send !== latest.current) return;
        setDelivery('sent');
        fade.current = setTimeout(() => setDelivery(null), SENT_SHOWN_MS);
    }, []);
    return { delivery, start, settle };
}
