import React from 'react';
import { Platform } from 'react-native';
import { storage } from '@/catalog/store';
import { updateFaviconWithNotification, resetFavicon } from '@/utils/web/faviconGenerator';
import { applyAppBadge } from '@/utils/web/appBadge';

/**
 * Component that monitors all sessions and updates the favicon and the app
 * icon badge when online sessions have pending permissions.
 */
export const FaviconPermissionIndicator = React.memo(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof document === 'undefined') {
        return null;
    }

    // The "needs you" count: online sessions with a pending permission request.
    // The favicon reads this same count (as a boolean) and the installed PWA
    // mirrors it on the app icon through the Badging API.
    const needsYouCount = storage((state) => {
        let count = 0;
        for (const session of Object.values(state.sessions)) {
            // Use centralized presence logic - only "online" sessions matter
            const isOnline = session.presence === 'online';

            const hasPermissions = session.agentState?.requests &&
                Object.keys(session.agentState.requests).length > 0;

            if (isOnline && hasPermissions) count += 1;
        }
        return count;
    });

    React.useLayoutEffect(() => {
        if (needsYouCount > 0) {
            updateFaviconWithNotification();
        } else {
            resetFavicon();
        }
        applyAppBadge(needsYouCount);
    }, [needsYouCount]);

    React.useLayoutEffect(() => {
        return () => {
            resetFavicon();
            applyAppBadge(0);
        };
    }, []);

    return null;
});

FaviconPermissionIndicator.displayName = 'FaviconPermissionIndicator';