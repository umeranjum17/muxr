import { useState, useCallback } from 'react';
import {
    getLastViewedTitle,
    setLastViewedTitle,
    getLatestTitle
} from '@/changelog';

export function useChangelog() {
    const latestTitle = getLatestTitle();

    const [hasUnread, setHasUnread] = useState(() => {
        const lastViewed = getLastViewedTitle();
        if (!lastViewed && latestTitle) {
            setLastViewedTitle(latestTitle);
            return false;
        }
        return latestTitle !== lastViewed;
    });

    const markAsRead = useCallback(() => {
        if (latestTitle) {
            setLastViewedTitle(latestTitle);
            setHasUnread(false);
        }
    }, [latestTitle]);

    return {
        hasUnread,
        latestTitle,
        markAsRead
    };
}
