import { useState, useCallback } from 'react';
import { getLastViewedRelease, setLastViewedRelease } from '../infrastructure/storage';
import { selectRelease } from '../domain/parser';
import { getAppVersion } from '@/utils/appVersion';

/** Unread state follows the installed app version, not a title that can be reworded. */
export function currentRelease() {
    const appVersion = getAppVersion();
    try {
        return selectRelease(appVersion);
    } catch (error) {
        console.warn('Changelog entry is unusable', error);
        return undefined;
    }
}

export function useChangelog() {
    const release = currentRelease();
    const identity = release?.appVersion ?? '';

    const [hasUnread, setHasUnread] = useState(() => {
        const lastViewed = getLastViewedRelease();
        if (!lastViewed && identity) {
            setLastViewedRelease(identity);
            return false;
        }
        return identity !== '' && identity !== lastViewed;
    });

    const markAsRead = useCallback(() => {
        if (identity) {
            setLastViewedRelease(identity);
            setHasUnread(false);
        }
    }, [identity]);

    return { hasUnread, release, markAsRead };
}
