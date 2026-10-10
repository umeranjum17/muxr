import React from 'react';
import { Platform } from 'react-native';
import { useNeedsYouCount } from '@/catalog/store';
import { updateFaviconWithNotification, resetFavicon } from '@/utils/web/faviconGenerator';
import { applyAppBadge } from '@/utils/web/appBadge';

/**
 * Component that updates the favicon and the app icon badge from the one
 * "needs you" count the in-app summary also reads, so all three agree.
 */
export const FaviconPermissionIndicator = React.memo(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof document === 'undefined') {
        return null;
    }

    const needsYouCount = useNeedsYouCount();

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
