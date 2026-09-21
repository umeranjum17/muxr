import * as React from 'react';
import { useRouter } from 'expo-router';
import { DesktopSurface } from '@/desktop';

/**
 * The live desktop, reached from the computer action on the terminal screen.
 *
 * Returning is this screen's own business: the route owns nothing about the
 * conversation underneath, so leaving it cannot disturb the session.
 */
export default function DesktopScreen() {
    const router = useRouter();
    const onExit = React.useCallback(() => {
        if (router.canGoBack()) router.back();
        else router.replace('/');
    }, [router]);
    return <DesktopSurface onExit={onExit} />;
}
