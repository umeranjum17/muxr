import type { SessionSnapshot } from '@desklink/react-native';

import { desktopCopy } from './desktopCopy';

export interface DesktopOverlay {
    title: string;
    detail?: string;
    /** One command to copy and run on the computer, shown with a Copy action. */
    command?: string;
    spinner: boolean;
    canRetry: boolean;
}

/**
 * The engine's revocation tokens mapped to what a person reads. The engine sends
 * short functional tokens; the product wording lives here, on the client, and an
 * unknown token falls back to neutral copy rather than being shown verbatim.
 */
const ENDED: Record<string, { detail: string; canRetry: boolean }> = {
    'the session lease expired': { detail: desktopCopy.endedTimeLimit, canRetry: true },
    'replaced by a new session': { detail: desktopCopy.endedTakeover, canRetry: true },
    'another device opened this computer': { detail: desktopCopy.endedTakeover, canRetry: true },
    'the desktop engine stopped': { detail: desktopCopy.endedEngineStopped, canRetry: true },
    // The picture travels directly, or through the Direct SSH connection when
    // that is the route; either way this is the path to the computer dropping.
    'the connection to the phone was lost': { detail: desktopCopy.endedUnreachable, canRetry: true },
    'the encoder rejected a frame': { detail: desktopCopy.endedUnencodable, canRetry: false },
};

function endedCopy(snapshot: SessionSnapshot): { detail: string; canRetry: boolean } {
    const known = snapshot.failure === null ? undefined : ENDED[snapshot.failure.message];
    return known ?? { detail: desktopCopy.endedBody, canRetry: true };
}

/**
 * What the overlay says, as one decision, so the states cannot drift apart.
 *
 * An ended session shows why it ended, in product words, with a retry only when
 * a retry can actually help. Until a desktop has opened on this device, the
 * start says where the one-time screen-sharing approval appears: on the
 * computer, where the person holding the phone would not think to look.
 */
export function describeDesktopOverlay(snapshot: SessionSnapshot, openedBefore = true, consentSecondsLeft: number | null = null): DesktopOverlay {
    if (snapshot.status === 'failed' && snapshot.failure?.code === 'consent') {
        // The prompt was on the computer, where nobody answered it; the host's
        // own wording would only say that it timed out.
        return { title: desktopCopy.consentTitle, detail: desktopCopy.consentBody, spinner: false, canRetry: true };
    }
    if (snapshot.status === 'failed' && snapshot.failure?.code === 'no-screen') {
        return { title: desktopCopy.noScreenTitle, detail: desktopCopy.noScreenBody, command: desktopCopy.noScreenCommand, spinner: false, canRetry: true };
    }
    if (snapshot.status === 'failed') {
        return {
            title: desktopCopy.failedTitle,
            detail: snapshot.failure?.message ?? desktopCopy.failedBody,
            spinner: false,
            canRetry: true,
        };
    }
    if (snapshot.status === 'ended') {
        const ended = endedCopy(snapshot);
        return {
            title: desktopCopy.endedTitle,
            detail: ended.detail,
            spinner: false,
            canRetry: ended.canRetry,
        };
    }
    if (snapshot.status === 'opening' && consentSecondsLeft !== null) {
        // The open is waiting on a person at the computer, so the phone says
        // where to look and how long the computer will wait.
        const left = Math.max(0, consentSecondsLeft);
        const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        return { title: desktopCopy.awaitingConsentTitle, detail: `${desktopCopy.awaitingConsentBody} ${clock} left.`, spinner: true, canRetry: false };
    }
    if (snapshot.status === 'reconnecting') {
        return { title: desktopCopy.reconnectingTitle, detail: desktopCopy.reconnectingBody, spinner: true, canRetry: false };
    }
    return {
        title: desktopCopy.startingTitle,
        detail: openedBefore ? desktopCopy.startingBody : desktopCopy.startingFirstTime,
        spinner: true,
        canRetry: false,
    };
}

const TEXT_REFUSED = new Map<string, string>([
    ['text-unsupported', desktopCopy.textUnsupported],
    ['text-too-large', desktopCopy.textTooLarge],
]);

/**
 * What to say when the desktop refused typed text, or null for a refusal the
 * person cannot act on. The way round is the explicit clipboard, when there is one.
 */
export function describeInputRejection(code: string, canPaste: boolean): string | null {
    const reason = TEXT_REFUSED.get(code);
    if (reason === undefined) return null;
    return canPaste ? `${reason} ${desktopCopy.textUsePaste}` : reason;
}
