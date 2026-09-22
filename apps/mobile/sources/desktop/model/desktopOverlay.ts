import type { SessionSnapshot } from '@desklink/react-native';

import { desktopCopy } from './desktopCopy';

export interface DesktopOverlay {
    title: string;
    detail?: string;
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
 * a retry can actually help.
 */
export function describeDesktopOverlay(snapshot: SessionSnapshot): DesktopOverlay {
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
    return {
        title: snapshot.status === 'reconnecting' ? desktopCopy.reconnectingTitle : desktopCopy.startingTitle,
        detail: snapshot.status === 'reconnecting' ? desktopCopy.reconnectingBody : desktopCopy.startingBody,
        spinner: true,
        canRetry: false,
    };
}
