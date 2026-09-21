import type { SessionSnapshot } from '@desklink/react-native';

import { desktopCopy } from './desktopCopy';

export interface DesktopOverlay {
    title: string;
    detail?: string;
    spinner: boolean;
    canRetry: boolean;
}

/**
 * What the overlay says, as one decision, so the states cannot drift apart.
 *
 * A session the engine ended carries its own reason; an ended session is over,
 * so it is shown without a retry that would only repeat the same failure.
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
        return {
            title: desktopCopy.endedTitle,
            detail: snapshot.failure?.message ?? desktopCopy.endedBody,
            spinner: false,
            canRetry: false,
        };
    }
    return {
        title: snapshot.status === 'reconnecting' ? desktopCopy.reconnectingTitle : desktopCopy.startingTitle,
        detail: snapshot.status === 'reconnecting' ? desktopCopy.reconnectingBody : desktopCopy.startingBody,
        spinner: true,
        canRetry: false,
    };
}
